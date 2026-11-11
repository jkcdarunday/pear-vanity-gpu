#include "native/engine.h"
#include <cstdlib>

static void require(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

static void keyFor(Search &search, unsigned key) {
  for (unsigned i = 0; i < 32; i++)
    search.searchKey.bytes[i] = key == 0 ? 0 : key == 1 ? 255 : i;
  search.setSearchKey();
}

// Runs every vector against one GPU backend. Software adapters are allowed so
// CI can use llvmpipe (Vulkan) and PoCL (OpenCL).
static void run(const std::string &backend) {
  const std::string configuration = "touch\n\n" + std::string(256, '0') + "\n\n64\n";
  {

    // Deterministic keys exist only in this test executable. The addon has no
    // deterministic-key option. Each dispatch checks eight GPU lanes against
    // independent libsodium seed derivation, Ed25519 and BLAKE2b operations.
    for (unsigned key = 0; key < 3; key++) {
      for (uint64_t counter :
           {uint64_t(0), (uint64_t(1) << 32) - 4, uint64_t(1) << 32, UINT64_MAX - 1024}) {
        Search search(configuration, backend, true, 65, 2);
        keyFor(search, key);
        search.counter = counter;
        if (key == 0 && counter == 0) {
          unsigned char seed[32];
          search.seedFor(0, seed);
          require(hex(seed, 32) ==
                      "76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7",
                  "ChaCha20 known-answer mismatch");
        }
        std::string result;
        do {
          result = search.step();
        } while (result.empty());
        require(search.completedBatches == 2, "Missing verification batches");
      }
    }

    // Independently construct known winning manifests, including z32 padding.
    // Counter 2^32 + 3 lands in the startup self-test batch. With 64-candidate
    // batches, 2^32 + 4 + 64 * 3 + 5 lands in the fourth pipelined batch, after
    // both slots have been reused, so results must come from the right slot.
    const std::string alphabet = "ybndrfg8ejkmcpqxot1uwisza345h769";
    for (uint64_t winnerCounter :
         {(uint64_t(1) << 32) + 3, (uint64_t(1) << 32) + 4 + 64 * 3 + 5}) {
      Secret key, seed;
      for (unsigned i = 0; i < 32; i++)
        key.bytes[i] = i;
      const unsigned char zero[32] = {}, nonce[8] = {};
      crypto_stream_chacha20_xor_ic(seed.bytes.data(), zero, 32, nonce, winnerCounter,
                                    key.bytes.data());
      unsigned char publicKey[32], secret[64], digest[32];
      crypto_sign_seed_keypair(publicKey, secret, seed.bytes.data());
      sodium_memzero(secret, sizeof(secret));
      Bytes manifest(128);
      std::copy(publicKey, publicKey + 32, manifest.begin() + 64);
      crypto_generichash(digest, 32, manifest.data(), manifest.size(), nullptr, 0);
      std::string encoded;
      for (unsigned bit = 0; bit < 260; bit += 5) {
        unsigned value = 0;
        for (unsigned j = 0; j < 5; j++) {
          value <<= 1;
          if (bit + j < 256)
            value |= (digest[(bit + j) / 8] >> (7 - (bit + j) % 8)) & 1;
        }
        encoded += alphabet[value];
      }
      const bool pipelined = winnerCounter > (uint64_t(1) << 32) + 3;
      for (size_t length : {1, 2, 3, 7, 25, 51, 52}) {
        // Short prefixes can also match earlier candidates; only the full
        // prefix pins the exact winner.
        if (pipelined && length < 25)
          continue;
        Search search("touch\n" + encoded.substr(0, length) + "\n" +
                          std::string(256, '0') + "\n\n64\n",
                      backend, true, 64, 0);
        keyFor(search, 2);
        std::string result;
        unsigned steps = 0;
        do {
          result = search.step();
          require(++steps <= 16, "Known winner was missed");
        } while (result.empty());
        if (length == 52)
          require(result == hex(seed.bytes.data(), 32), "Wrong full-prefix winner");
      }
    }

    Search exhausted(configuration, backend, true, 64, 0);
    exhausted.counter = UINT64_MAX - 3;
    bool rejected = false;
    try {
      exhausted.step();
    } catch (const std::runtime_error &error) {
      rejected = std::string(error.what()) == "Search counter exhausted";
    }
    require(rejected, "Counter wrap was not rejected before dispatch");
    std::cout << backend << " (" << exhausted.gpu->name
              << (exhausted.gpu->software ? ", software" : "")
              << "): native crypto vectors and counter boundaries passed\n";
  }
}

int main() {
  const char *selected = std::getenv("VANITY_NATIVE_BACKENDS");
  std::istringstream backends(selected && *selected ? selected : "vulkan");
  std::string backend;
  try {
    while (std::getline(backends, backend, ','))
      run(backend);
  } catch (const std::exception &error) {
    std::cerr << backend << ": " << error.what() << '\n';
    return 1;
  }
}
