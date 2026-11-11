#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <sodium.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "device.h"
#include "hip.h"
#include "opencl.h"
#include "vulkan.h"

using Bytes = std::vector<unsigned char>;

static Bytes unhex(const std::string &s) {
  if (s.empty())
    return {};
  if (s.size() % 2)
    throw std::runtime_error("Invalid hex input");
  Bytes out(s.size() / 2);
  if (sodium_hex2bin(out.data(), out.size(), s.data(), s.size(), nullptr, nullptr,
                     nullptr))
    throw std::runtime_error("Invalid hex input");
  return out;
}

static std::string hex(const unsigned char *bytes, size_t size) {
  std::string out(size * 2 + 1, '\0');
  sodium_bin2hex(out.data(), out.size(), bytes, size);
  out.resize(size * 2);
  return out;
}

static std::string line(std::istream &input) {
  std::string s;
  if (!std::getline(input, s) || s.size() > 16384)
    throw std::runtime_error("Invalid helper input");
  return s;
}

static std::string suffix(uint64_t counter) {
  std::string s(16, '0');
  for (int i = 15; i >= 0; i--) {
    s[i] = "0123456789abcdef"[counter & 15];
    counter >>= 4;
  }
  return s;
}

struct Secret {
  std::array<unsigned char, 32> bytes{};

  ~Secret() { sodium_memzero(bytes.data(), bytes.size()); }
};

// Host copy of the device configuration, which contains the touch search key.
struct SecretWords {
  std::vector<uint32_t> words = std::vector<uint32_t>(configWords);

  ~SecretWords() { sodium_memzero(words.data(), words.size() * sizeof(uint32_t)); }
};

static std::string jsonString(const std::string &value) {
  std::string result = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\')
      result += '\\';
    if (c < 32)
      result += "\\u00" + hex(&c, 1);
    else
      result += char(c);
  }
  return result + "\"";
}

static std::unique_ptr<Device> createDevice(const std::string &backend,
                                            const DeviceOptions &options) {
  if (backend == "vulkan")
    return std::make_unique<VulkanDevice>(options);
  if (backend == "opencl")
    return std::make_unique<OpenCLDevice>(options);
  if (backend == "hip")
    return std::make_unique<HipDevice>(options);
  throw std::runtime_error("Unknown GPU backend");
}

struct Search {
  std::unique_ptr<Device> gpu;
  Secret searchKey;
  SecretWords config;
  Bytes manifest, base;
  std::vector<uint32_t> offsets;
  std::string mode, target, stem;
  const std::string alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
  uint32_t batch = 0, benchmarkBatches = 0, completedBatches = 0, submittedBatches = 0;
  // Next candidate to submit. Startup samples cross a 32-bit counter boundary to
  // exercise both words.
  uint64_t counter = (uint64_t(1) << 32) - 4;
  // Template for the next submission.
  Parameters p{};
  bool selfTest = true, selfTestSubmitted = false, exhausted = false, finished = false,
       uploaded = false;

  // Batches queued on the device, oldest at `head`. Results are verified in
  // submission order, so the first winner by counter is still the one returned.
  struct Flight {
    bool active = false;
    uint64_t counter = 0;
    Parameters params{};
  };

  std::array<Flight, deviceSlots> flights{};
  unsigned head = 0, tail = 0;
  std::array<uint32_t, resultWords> output{};
  std::chrono::steady_clock::time_point started;
  double preparationSeconds = 0, dispatchSeconds = 0, verificationSeconds = 0,
         gpuSeconds = 0;

  Search(const std::string &configuration, const std::string &backend, bool software,
         uint32_t requestedBatch, uint32_t benchmark,
         const std::string &cacheDirectory = "")
      : benchmarkBatches(benchmark) {
    if (sodium_init() < 0)
      throw std::runtime_error("Cannot initialize secure randomness");
    if (requestedBatch && (requestedBatch < 64 || requestedBatch > maxBatch))
      throw std::runtime_error("Batch size must be between 64 and 1048576");
    if (benchmark > 100000)
      throw std::runtime_error("Invalid benchmark batch count");
    std::istringstream input(configuration);
    mode = line(input);
    target = line(input);
    if (mode != "touch" && mode != "multisig")
      throw std::runtime_error("Invalid search mode");
    if (target.size() > 52 || target.find_first_not_of(alphabet) != std::string::npos ||
        (target.size() == 52 && alphabet.find(target.back()) % 16 != 0))
      throw std::runtime_error("Invalid z32 prefix");
    manifest = unhex(line(input));
    base = unhex(line(input));
    std::istringstream offsetsInput(line(input));
    std::string token;
    while (offsetsInput >> token) {
      if (token.size() > 10 || token.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error("Invalid manifest patch offset");
      auto offset = std::stoull(token);
      if (offset > UINT32_MAX)
        throw std::runtime_error("Invalid manifest patch offset");
      offsets.push_back(uint32_t(offset));
    }
    if (!offsetsInput.eof() || input.peek() != std::char_traits<char>::eof())
      throw std::runtime_error("Invalid search configuration");
    if (manifest.empty() || manifest.size() > 4096 || base.size() > 1983 ||
        offsets.empty() || offsets.size() > 64)
      throw std::runtime_error("Unsupported manifest or namespace size");
    for (size_t i = 0; i < offsets.size(); i++) {
      auto off = offsets[i];
      if (off > manifest.size() || manifest.size() - off < 32 ||
          (i && off < offsets[i - 1] + 32))
        throw std::runtime_error("Invalid manifest patch offset");
    }
    if (mode == "touch" && offsets.size() != 1)
      throw std::runtime_error("Invalid touch manifest");
    unsigned char salt[32];
    randombytes_buf(salt, sizeof(salt));
    stem.assign(base.begin(), base.end());
    stem += "$" + hex(salt, sizeof(salt));

    DeviceOptions options;
    options.software = software;
    options.mode = mode == "touch" ? 0 : 1;
    options.benchmark = benchmark != 0;
    options.cacheDirectory = cacheDirectory;
    gpu = createDevice(backend, options);
    batch = requestedBatch ? requestedBatch : defaultBatch();
    gpu->prepare(batch);

    auto cfg = config.words.data();
    for (auto off : offsets)
      for (uint32_t i = 0; i < 32; i++)
        cfg[6260 + off + i] = i + 1;
    std::copy(manifest.begin(), manifest.end(), cfg);
    // std::string may have signed chars (UTF-8 namespaces).
    for (size_t i = 0; i < stem.size(); i++)
      cfg[4096 + i] = static_cast<unsigned char>(stem[i]);
    std::copy(offsets.begin(), offsets.end(), cfg + 6144);
    for (size_t i = 0; i < target.size(); i++) {
      const uint32_t value = alphabet.find(target[i]);
      for (uint32_t j = 0; j < 5 && i * 5 + j < 256; j++) {
        uint32_t bit = uint32_t(i * 5 + j), byte = bit / 8;
        uint32_t word = byte / 4, shift = (byte % 4) * 8 + 7 - bit % 8;
        cfg[6208 + word] |= 1u << shift;
        if (value & (1u << (4 - j)))
          cfg[6216 + word] |= 1u << shift;
      }
    }
    p = Parameters{options.mode,
                   8,
                   uint32_t(manifest.size()),
                   uint32_t(stem.size()),
                   uint32_t(offsets.size()),
                   uint32_t(target.size()),
                   0,
                   0,
                   8};
    randombytes_buf(searchKey.bytes.data(), searchKey.bytes.size());
    setSearchKey();
    started = std::chrono::steady_clock::now();
  }

  // Hardware defaults from batch sweeps; software devices favor responsiveness.
  // Searches of five or more characters (about 33 million expected candidates)
  // use 2^20 batches, which keep the GPU nearly saturated; shorter searches keep
  // smaller batches so little work is wasted after the first match.
  uint32_t defaultBatch() const {
    if (gpu->software)
      return mode == "touch" ? 256 : 8192;
    if (target.size() >= 5)
      return maxBatch;
    if (mode != "touch")
      return 65536;
    return target.size() <= 2 ? 1024 : target.size() <= 3 ? 8192 : 65536;
  }

  void setSearchKey() {
    for (uint32_t word = 0; word < 8; word++) {
      uint32_t value = 0;
      for (uint32_t byte = 0; byte < 4; byte++)
        value |= uint32_t(searchKey.bytes[word * 4 + byte]) << (byte * 8);
      config.words[6224 + word] = value;
    }
  }

  void seedFor(uint64_t index, unsigned char seed[32]) const {
    const unsigned char zero[32] = {}, nonce[crypto_stream_chacha20_NONCEBYTES] = {};
    crypto_stream_chacha20_xor_ic(seed, zero, sizeof(zero), nonce, index,
                                  searchKey.bytes.data());
  }

  bool canSubmit() const {
    if (finished || exhausted || flights[tail].active)
      return false;
    if (selfTest)
      return !selfTestSubmitted;
    return !benchmarkBatches || submittedBatches < benchmarkBatches;
  }

  // Queues batches into every idle slot. The startup self-test runs alone so
  // the device is checked before any pipelined work is trusted.
  void fill() {
    while (canSubmit()) {
      if (counter > UINT64_MAX - (p.count - 1)) {
        exhausted = true;
        break;
      }
      p.counterLow = uint32_t(counter);
      p.counterHigh = uint32_t(counter >> 32);
      gpu->submit(tail, p);
      flights[tail] = Flight{true, counter, p};
      tail = (tail + 1) % deviceSlots;
      if (selfTest)
        selfTestSubmitted = true;
      else
        submittedBatches++;
      if (UINT64_MAX - counter < p.count)
        exhausted = true;
      else
        counter += p.count;
    }
  }

  // Checks diagnostic samples and any winner against libsodium. Returns the
  // winning index, or UINT32_MAX when the batch has none.
  uint32_t verify(const Flight &flight) {
    const Parameters &params = flight.params;
    uint32_t winner = output[0];
    if (winner != UINT32_MAX && winner >= params.count)
      throw std::runtime_error("Invalid GPU winner index");
    uint32_t checks = params.diagnosticCount + (winner < params.count ? 1 : 0);
    for (uint32_t j = 0; j < checks; j++) {
      bool winningSlot = j == params.diagnosticCount;
      uint32_t i = winningSlot ? winner : j * (params.count - 1) / 7;
      unsigned char patch[32], digest[32];
      if (params.mode == 0) {
        unsigned char secret[64], seed[32];
        seedFor(flight.counter + i, seed);
        crypto_sign_seed_keypair(patch, secret, seed);
        sodium_memzero(seed, sizeof(seed));
        sodium_memzero(secret, sizeof(secret));
      } else {
        auto ns = stem + suffix(flight.counter + i);
        crypto_generichash(patch, 32, reinterpret_cast<const unsigned char *>(ns.data()),
                           ns.size(), nullptr, 0);
      }
      auto candidate = manifest;
      for (auto off : offsets)
        std::copy(patch, patch + 32, candidate.begin() + off);
      crypto_generichash(digest, 32, candidate.data(), candidate.size(), nullptr, 0);
      if (winningSlot) {
        for (size_t bit = 0; bit < std::min(size_t(256), target.size() * 5); bit++) {
          auto expected = (alphabet.find(target[bit / 5]) >> (4 - bit % 5)) & 1;
          if (((digest[bit / 8] >> (7 - bit % 8)) & 1) != expected)
            throw std::runtime_error("GPU winner failed prefix verification");
        }
      }
      auto slot = output.data() + 1 + (winningSlot ? 8 : j) * 16;
      for (uint32_t k = 0; k < 32; k++)
        if (((slot[k / 4] >> ((k % 4) * 8)) & 255) != patch[k] ||
            ((slot[k / 4 + 8] >> ((k % 4) * 8)) & 255) != digest[k])
          throw std::runtime_error("GPU crypto self-test failed");
    }
    return winner < params.count ? winner : UINT32_MAX;
  }

  std::string step() {
    using Clock = std::chrono::steady_clock;
    if (finished)
      throw std::runtime_error("Vanity search is already finished");
    if (!uploaded) {
      gpu->upload(config.words.data(), basepoint_table, sizeof(basepoint_table));
      uploaded = true;
      // The device holds the search key now; keep no extra host copy.
      sodium_memzero(config.words.data(), config.words.size() * sizeof(uint32_t));
    }
    const auto preparationStart = Clock::now();
    const auto dispatchStart = Clock::now();
    fill();
    if (!flights[head].active)
      throw std::runtime_error("Search counter exhausted");
    const Flight flight = flights[head];
    const uint32_t *result = gpu->wait(head);
    std::copy(result, result + resultWords, output.begin());
    const double batchGpuSeconds = gpu->lastGpuSeconds;
    flights[head].active = false;
    head = (head + 1) % deviceSlots;
    const bool measured = benchmarkBatches && !selfTest;
    // Refill before verifying so the device works while the CPU checks.
    if (!selfTest)
      fill();
    const auto verificationStart = Clock::now();
    const uint32_t winner = verify(flight);
    const auto verificationEnd = Clock::now();

    if (selfTest) {
      selfTest = false;
      p.count = batch;
      p.diagnosticCount = benchmarkBatches ? 8 : 0;
      if (!benchmarkBatches && winner != UINT32_MAX)
        return found(flight, winner);
      if (benchmarkBatches)
        started = Clock::now();
      fill();
      return {};
    }

    if (measured) {
      gpuSeconds += batchGpuSeconds;
      preparationSeconds +=
          std::chrono::duration<double>(dispatchStart - preparationStart).count();
      dispatchSeconds +=
          std::chrono::duration<double>(verificationStart - dispatchStart).count();
      verificationSeconds +=
          std::chrono::duration<double>(verificationEnd - verificationStart).count();
      if (++completedBatches == benchmarkBatches)
        return report();
      return {};
    }

    if (winner != UINT32_MAX)
      return found(flight, winner);
    return {};
  }

  std::string found(const Flight &flight, uint32_t winner) {
    finished = true;
    if (flight.params.mode == 0) {
      unsigned char seed[32];
      seedFor(flight.counter + winner, seed);
      auto result = hex(seed, sizeof(seed));
      sodium_memzero(seed, sizeof(seed));
      return result;
    }
    auto ns = stem + suffix(flight.counter + winner);
    return hex(reinterpret_cast<const unsigned char *>(ns.data()), ns.size());
  }

  std::string report() {
    finished = true;
    const double seconds =
        std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    const uint64_t candidates = uint64_t(batch) * completedBatches;
    std::ostringstream json;
    json << "{\"backend\":" << jsonString(gpu->backend)
         << ",\"device\":" << jsonString(gpu->name)
         << ",\"software\":" << (gpu->software ? "true" : "false")
         << ",\"mode\":" << jsonString(mode) << ",\"batchSize\":" << batch
         << ",\"candidates\":" << candidates << ",\"seconds\":" << seconds
         << ",\"candidatesPerSecond\":" << candidates / seconds
         << ",\"preparationSeconds\":" << preparationSeconds
         << ",\"dispatchSeconds\":" << dispatchSeconds
         << ",\"verificationSeconds\":" << verificationSeconds
         << ",\"requiredSubgroupSize\":"
         << (gpu->requiredSubgroupSize ? std::to_string(gpu->requiredSubgroupSize)
                                       : "null")
         << ",\"gpuSeconds\":" << (gpu->timestamps ? std::to_string(gpuSeconds) : "null")
         << ",\"readbackBytesPerBatch\":" << resultWords * sizeof(uint32_t) << "}\n";
    return json.str();
  }
};
