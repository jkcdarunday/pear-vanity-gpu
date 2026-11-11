#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

#include "basepoint-table.h"

// Shared buffer layout used by every backend and by search.comp:
//   config[0, 4096)       manifest template bytes, one per word
//   config[4096, 6144)    namespace stem bytes
//   config[6144, 6208)    signer patch offsets
//   config[6208, 6216)    prefix bit mask
//   config[6216, 6224)    prefix bit values
//   config[6224, 6232)    touch ChaCha20 search key (secret)
//   config[6260, 10356)   per-byte patch lookup
//   results[0]            first winner index, UINT32_MAX when none
//   results[1 + 16 * k]   slot k: 8 replacement words then 8 digest words
constexpr size_t configWords = 6260 + 4096;
constexpr size_t resultWords = 1 + 9 * 16;
constexpr unsigned deviceSlots = 2;
constexpr uint32_t maxBatch = uint32_t(1) << 20;

struct Parameters {
  uint32_t mode, count, templateLen, namespaceLen, offsetCount, targetLen, counterLow,
      counterHigh, diagnosticCount;
};

struct DeviceOptions {
  bool software = false;
  uint32_t mode = 0;
  bool benchmark = false;
  std::string cacheDirectory;
};

class Device {
public:
  virtual ~Device() = default;

  // Validates and reserves resources for batches of up to `batch` candidates.
  virtual void prepare(uint32_t batch) = 0;

  // Copies the configuration (including the search key) and public table.
  virtual void upload(const uint32_t *config, const uint32_t *table,
                      size_t tableBytes) = 0;

  // Two dispatches may be in flight at once, one per slot, so the GPU starts
  // the next batch while the CPU reads back and verifies the previous one.
  // `submit` queues a dispatch into an idle slot without waiting for it.
  virtual void submit(unsigned slot, const Parameters &params) = 0;

  // Waits for the slot's dispatch and returns `resultWords` host-readable words,
  // valid until that slot is submitted again. Sets `lastGpuSeconds`.
  virtual const uint32_t *wait(unsigned slot) = 0;

  const char *backend = "";
  std::string name;
  bool software = false;
  bool timestamps = false;
  double lastGpuSeconds = 0;
  uint32_t requiredSubgroupSize = 0;
};
