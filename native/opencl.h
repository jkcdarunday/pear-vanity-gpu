#pragma once

#ifndef CL_TARGET_OPENCL_VERSION
#define CL_TARGET_OPENCL_VERSION 120
#endif
#define CL_USE_DEPRECATED_OPENCL_1_2_APIS
#ifdef __APPLE__
#include <OpenCL/cl.h>
#else
#include <CL/cl.h>
#endif

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "cache.h"
#include "device.h"
#include "kernel.h"
#include "library.h"

// Functions are resolved from the ICD loader at runtime; the declarations in
// CL/cl.h are used only for their types and are never linked.
#define VANITY_OPENCL_FUNCTIONS(X)                                                       \
  X(clGetPlatformIDs)                                                                    \
  X(clGetPlatformInfo)                                                                   \
  X(clGetDeviceIDs)                                                                      \
  X(clGetDeviceInfo)                                                                     \
  X(clCreateContext)                                                                     \
  X(clReleaseContext)                                                                    \
  X(clCreateCommandQueue)                                                                \
  X(clReleaseCommandQueue)                                                               \
  X(clCreateProgramWithSource)                                                           \
  X(clCreateProgramWithBinary)                                                           \
  X(clBuildProgram)                                                                      \
  X(clGetProgramBuildInfo)                                                               \
  X(clGetProgramInfo)                                                                    \
  X(clReleaseProgram)                                                                    \
  X(clCreateKernel)                                                                      \
  X(clReleaseKernel)                                                                     \
  X(clGetKernelWorkGroupInfo)                                                            \
  X(clSetKernelArg)                                                                      \
  X(clCreateBuffer)                                                                      \
  X(clReleaseMemObject)                                                                  \
  X(clEnqueueReadBuffer)                                                                 \
  X(clEnqueueFillBuffer)                                                                 \
  X(clEnqueueNDRangeKernel)                                                              \
  X(clFinish)                                                                            \
  X(clFlush)                                                                             \
  X(clWaitForEvents)                                                                     \
  X(clGetEventInfo)                                                                      \
  X(clGetEventProfilingInfo)                                                             \
  X(clReleaseEvent)

struct OpenCLApi {
#define VANITY_OPENCL_MEMBER(name) decltype(&::name) name = nullptr;
  VANITY_OPENCL_FUNCTIONS(VANITY_OPENCL_MEMBER)
#undef VANITY_OPENCL_MEMBER

  OpenCLApi()
      : library(
#if defined(_WIN32)
            {"OpenCL.dll"},
#elif defined(__APPLE__)
            {"/System/Library/Frameworks/OpenCL.framework/OpenCL"},
#else
            {"libOpenCL.so.1", "libOpenCL.so"},
#endif
            "OpenCL") {
#define VANITY_OPENCL_LOAD(name) library.load(name, #name);
    VANITY_OPENCL_FUNCTIONS(VANITY_OPENCL_LOAD)
#undef VANITY_OPENCL_LOAD
  }

private:
  Library library;
};

static const OpenCLApi &openclApi() {
  static const OpenCLApi api;
  return api;
}

static void checkCL(cl_int status, const char *operation) {
  if (status != CL_SUCCESS)
    throw std::runtime_error(std::string("OpenCL ") + operation + " failed with status " +
                             std::to_string(status));
}

class OpenCLDevice : public Device {
public:
  explicit OpenCLDevice(const DeviceOptions &options) : cl(openclApi()) {
    backend = "opencl";
    try {
      init(options);
    } catch (...) {
      destroy();
      throw;
    }
  }

  ~OpenCLDevice() override { destroy(); }

  void prepare(uint32_t batch) override {
    if (batch == 0 || batch > maxBatch)
      throw std::runtime_error("Invalid OpenCL batch size");
  }

  void upload(const uint32_t *config, const uint32_t *table, size_t tableBytes) override {
    cl_int status;
    release(buffers[0]);
    release(buffers[1]);
    buffers[0] = cl.clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                                   configWords * sizeof(uint32_t),
                                   const_cast<uint32_t *>(config), &status);
    checkCL(status, "configuration upload");
    buffers[1] = cl.clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                                   tableBytes, const_cast<uint32_t *>(table), &status);
    checkCL(status, "table upload");
    for (cl_uint i = 0; i < 2; i++)
      checkCL(cl.clSetKernelArg(kernel, i, sizeof(cl_mem), &buffers[i]),
              "argument setup");
  }

  // Kernel arguments are captured at enqueue time, so each slot can bind its
  // own result buffer. The in-order queue keeps the device fed while the host
  // verifies the previous slot.
  void submit(unsigned slot, const Parameters &params) override {
    Slot &target = slots[slot];
    cl_mem &results = buffers[2 + slot];
    checkCL(cl.clSetKernelArg(kernel, 2, sizeof(cl_mem), &results), "argument setup");
    checkCL(cl.clSetKernelArg(kernel, 3, sizeof(params), &params), "argument setup");
    const cl_uint sentinel = UINT32_MAX;
    checkCL(cl.clEnqueueFillBuffer(queue, results, &sentinel, sizeof(sentinel), 0,
                                   sizeof(sentinel), 0, nullptr, nullptr),
            "result reset");
    const size_t global = (size_t(params.count) + localSize - 1) / localSize * localSize;
    checkCL(cl.clEnqueueNDRangeKernel(queue, kernel, 1, nullptr, &global, &localSize, 0,
                                      nullptr, timestamps ? &target.kernel : nullptr),
            "dispatch");
    checkCL(cl.clEnqueueReadBuffer(queue, results, CL_FALSE, 0, sizeof(target.output),
                                   target.output.data(), 0, nullptr, &target.read),
            "readback");
    checkCL(cl.clFlush(queue), "submission");
  }

  const uint32_t *wait(unsigned slot) override {
    Slot &target = slots[slot];
    cl_int status = cl.clWaitForEvents(1, &target.read);
    cl_int execution = CL_COMPLETE;
    if (status == CL_SUCCESS)
      status = cl.clGetEventInfo(target.read, CL_EVENT_COMMAND_EXECUTION_STATUS,
                                 sizeof(execution), &execution, nullptr);
    if (status == CL_SUCCESS && execution < 0)
      status = execution;
    if (target.kernel && status == CL_SUCCESS) {
      cl_ulong begin = 0, end = 0;
      status = cl.clGetEventProfilingInfo(target.kernel, CL_PROFILING_COMMAND_START,
                                          sizeof(begin), &begin, nullptr);
      if (status == CL_SUCCESS)
        status = cl.clGetEventProfilingInfo(target.kernel, CL_PROFILING_COMMAND_END,
                                            sizeof(end), &end, nullptr);
      lastGpuSeconds = double(end - begin) * 1e-9;
    }
    target.release(cl);
    checkCL(status, "readback");
    return target.output.data();
  }

private:
  const OpenCLApi &cl;
  cl_context context = nullptr;
  cl_command_queue queue = nullptr;
  cl_program program = nullptr;
  cl_kernel kernel = nullptr;

  struct Slot {
    std::array<uint32_t, resultWords> output{};
    cl_event kernel = nullptr, read = nullptr;

    void release(const OpenCLApi &cl) noexcept {
      for (auto *event : {&kernel, &read}) {
        if (*event)
          cl.clReleaseEvent(*event);
        *event = nullptr;
      }
    }
  };

  // 0: configuration, 1: basepoint table, 2 + slot: per-slot results.
  std::array<cl_mem, 2 + deviceSlots> buffers{};
  std::array<Slot, deviceSlots> slots{};
  size_t localSize = 64;

  void release(cl_mem &buffer) noexcept {
    if (buffer)
      cl.clReleaseMemObject(buffer);
    buffer = nullptr;
  }

  void destroy() noexcept {
    if (queue) {
      // Overwrite the device copy of the search key before releasing it.
      if (buffers[0]) {
        const cl_uint zero = 0;
        cl.clEnqueueFillBuffer(queue, buffers[0], &zero, sizeof(zero), 0,
                               configWords * sizeof(uint32_t), 0, nullptr, nullptr);
      }
      cl.clFinish(queue);
    }
    for (auto &slot : slots)
      slot.release(cl);
    for (auto &buffer : buffers)
      release(buffer);
    if (kernel)
      cl.clReleaseKernel(kernel);
    if (program)
      cl.clReleaseProgram(program);
    if (queue)
      cl.clReleaseCommandQueue(queue);
    if (context)
      cl.clReleaseContext(context);
    kernel = nullptr;
    program = nullptr;
    queue = nullptr;
    context = nullptr;
  }

  std::string platformString(cl_platform_id platform, cl_platform_info param) const {
    size_t size = 0;
    if (cl.clGetPlatformInfo(platform, param, 0, nullptr, &size) != CL_SUCCESS || !size)
      return "";
    std::string value(size, '\0');
    if (cl.clGetPlatformInfo(platform, param, size, value.data(), nullptr) != CL_SUCCESS)
      return "";
    return value.c_str();
  }

  std::string deviceString(cl_device_id device, cl_device_info param) const {
    size_t size = 0;
    if (cl.clGetDeviceInfo(device, param, 0, nullptr, &size) != CL_SUCCESS || !size)
      return "";
    std::string value(size, '\0');
    if (cl.clGetDeviceInfo(device, param, size, value.data(), nullptr) != CL_SUCCESS)
      return "";
    return value.c_str();
  }

  template <typename T> T deviceValue(cl_device_id device, cl_device_info param) const {
    T value{};
    if (cl.clGetDeviceInfo(device, param, sizeof(value), &value, nullptr) != CL_SUCCESS)
      return T{};
    return value;
  }

  // "OpenCL 1.2 ..." style version strings; 1.2 adds clEnqueueFillBuffer.
  static bool atLeast12(const std::string &version) {
    int major = 0, minor = 0;
    if (std::sscanf(version.c_str(), "OpenCL %d.%d", &major, &minor) != 2)
      return false;
    return major > 1 || (major == 1 && minor >= 2);
  }

  void init(const DeviceOptions &options) {
    cl_uint platformCount = 0;
    if (cl.clGetPlatformIDs(0, nullptr, &platformCount) != CL_SUCCESS || !platformCount)
      throw std::runtime_error("No OpenCL platforms are installed");
    std::vector<cl_platform_id> platforms(platformCount);
    checkCL(cl.clGetPlatformIDs(platformCount, platforms.data(), nullptr),
            "platform query");

    cl_platform_id platform = nullptr;
    cl_device_id device = nullptr;
    uint64_t best = 0;
    const cl_device_type types =
        CL_DEVICE_TYPE_GPU | (options.software ? CL_DEVICE_TYPE_CPU : 0);
    for (auto candidatePlatform : platforms) {
      if (!atLeast12(platformString(candidatePlatform, CL_PLATFORM_VERSION)))
        continue;
      cl_uint count = 0;
      if (cl.clGetDeviceIDs(candidatePlatform, types, 0, nullptr, &count) != CL_SUCCESS ||
          !count)
        continue;
      std::vector<cl_device_id> devices(count);
      if (cl.clGetDeviceIDs(candidatePlatform, types, count, devices.data(), nullptr) !=
          CL_SUCCESS)
        continue;
      for (auto candidate : devices) {
        const auto type = deviceValue<cl_device_type>(candidate, CL_DEVICE_TYPE);
        if (!deviceValue<cl_bool>(candidate, CL_DEVICE_AVAILABLE) ||
            !deviceValue<cl_bool>(candidate, CL_DEVICE_COMPILER_AVAILABLE) ||
            !deviceValue<cl_bool>(candidate, CL_DEVICE_LINKER_AVAILABLE) ||
            deviceString(candidate, CL_DEVICE_PROFILE) != "FULL_PROFILE" ||
            !atLeast12(deviceString(candidate, CL_DEVICE_VERSION)) ||
            deviceValue<cl_ulong>(candidate, CL_DEVICE_MAX_CONSTANT_BUFFER_SIZE) <
                configWords * sizeof(uint32_t) ||
            deviceValue<size_t>(candidate, CL_DEVICE_MAX_WORK_GROUP_SIZE) < 1)
          continue;
        // Prefer GPUs, then the device with the most compute units.
        const uint64_t score =
            (type & CL_DEVICE_TYPE_GPU ? uint64_t(1) << 32 : 0) +
            deviceValue<cl_uint>(candidate, CL_DEVICE_MAX_COMPUTE_UNITS);
        if (score > best) {
          best = score;
          platform = candidatePlatform;
          device = candidate;
        }
      }
    }
    if (!device)
      throw std::runtime_error("No OpenCL GPU with OpenCL 1.2 full-profile support");

    name = deviceString(device, CL_DEVICE_NAME);
    name.erase(name.find_last_not_of(" \t") + 1);
    software =
        !(deviceValue<cl_device_type>(device, CL_DEVICE_TYPE) & CL_DEVICE_TYPE_GPU);

    cl_int status;
    cl_context_properties properties[] = {CL_CONTEXT_PLATFORM,
                                          cl_context_properties(platform), 0};
    context = cl.clCreateContext(properties, 1, &device, nullptr, nullptr, &status);
    checkCL(status, "context creation");
    timestamps = options.benchmark;
    queue = cl.clCreateCommandQueue(context, device,
                                    timestamps ? CL_QUEUE_PROFILING_ENABLE : 0, &status);
    checkCL(status, "queue creation");

    const std::string source = std::string(opencl_prelude) + kernel_source;
    const std::string flags =
        std::string("-cl-std=CL1.2 -DTOUCH=") + (options.mode == 0 ? "1" : "0");
    const std::string identity = std::string("pear-vanity-gpu opencl kernel 1\n") +
                                 platformString(platform, CL_PLATFORM_NAME) + "\n" +
                                 platformString(platform, CL_PLATFORM_VERSION) + "\n" +
                                 name + "\n" + deviceString(device, CL_DEVICE_VERSION) +
                                 "\n" + deviceString(device, CL_DRIVER_VERSION) + "\n" +
                                 flags + "\n" + source;
    KernelCache cache(options.cacheDirectory, identity);
    std::vector<unsigned char> binary;
    if (cache.load(binary))
      buildBinary(device, binary, flags);
    if (!program) {
      buildSource(device, source, flags);
      cache.store(programBinary());
    }

    kernel = cl.clCreateKernel(program, "searchKernel", &status);
    checkCL(status, "kernel creation");

    // The kernel uses no local memory or barriers, so any work-group size is
    // valid; prefer the measured sizes and respect the compiled kernel limit.
    size_t limit = 0;
    checkCL(cl.clGetKernelWorkGroupInfo(kernel, device, CL_KERNEL_WORK_GROUP_SIZE,
                                        sizeof(limit), &limit, nullptr),
            "kernel query");
    localSize = options.mode == 0 ? 64 : 128;
    while (localSize > 1 && localSize > limit)
      localSize /= 2;

    for (unsigned slot = 0; slot < deviceSlots; slot++) {
      buffers[2 + slot] = cl.clCreateBuffer(
          context, CL_MEM_READ_WRITE, resultWords * sizeof(uint32_t), nullptr, &status);
      checkCL(status, "result allocation");
    }
  }

  void buildBinary(cl_device_id device, const std::vector<unsigned char> &binary,
                   const std::string &flags) {
    const unsigned char *pointer = binary.data();
    size_t length = binary.size();
    cl_int status, binaryStatus;
    program = cl.clCreateProgramWithBinary(context, 1, &device, &length, &pointer,
                                           &binaryStatus, &status);
    if (status == CL_SUCCESS && binaryStatus == CL_SUCCESS &&
        cl.clBuildProgram(program, 1, &device, flags.c_str(), nullptr, nullptr) ==
            CL_SUCCESS)
      return;
    if (program)
      cl.clReleaseProgram(program);
    program = nullptr;
  }

  void buildSource(cl_device_id device, const std::string &source,
                   const std::string &flags) {
    const char *pointer = source.c_str();
    size_t length = source.size();
    cl_int status;
    program = cl.clCreateProgramWithSource(context, 1, &pointer, &length, &status);
    checkCL(status, "program creation");
    status = cl.clBuildProgram(program, 1, &device, flags.c_str(), nullptr, nullptr);
    if (status != CL_SUCCESS) {
      size_t size = 0;
      cl.clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, 0, nullptr, &size);
      std::string log(std::min(size, size_t(4096)), '\0');
      if (!log.empty())
        cl.clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, log.size(),
                                 log.data(), nullptr);
      throw std::runtime_error("OpenCL kernel build failed with status " +
                               std::to_string(status) + ": " + log.c_str());
    }
  }

  std::vector<unsigned char> programBinary() const {
    size_t size = 0;
    if (cl.clGetProgramInfo(program, CL_PROGRAM_BINARY_SIZES, sizeof(size), &size,
                            nullptr) != CL_SUCCESS ||
        !size)
      return {};
    std::vector<unsigned char> binary(size);
    unsigned char *pointer = binary.data();
    if (cl.clGetProgramInfo(program, CL_PROGRAM_BINARIES, sizeof(pointer), &pointer,
                            nullptr) != CL_SUCCESS)
      return {};
    return binary;
  }
};
