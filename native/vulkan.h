#pragma once

#define VK_NO_PROTOTYPES
#include <algorithm>
#include <array>
#include <cstring>
#include <sodium.h>
#include <stdexcept>
#include <string>
#include <vector>
#include <vulkan/vulkan.h>

#include "device.h"
#include "library.h"
#include "multisig.h"
#include "touch.h"

#define VANITY_VULKAN_INSTANCE_FUNCTIONS(X)                                              \
  X(vkDestroyInstance)                                                                   \
  X(vkEnumeratePhysicalDevices)                                                          \
  X(vkGetPhysicalDeviceFeatures)                                                         \
  X(vkGetPhysicalDeviceProperties)                                                       \
  X(vkGetPhysicalDeviceQueueFamilyProperties)                                            \
  X(vkGetPhysicalDeviceMemoryProperties)                                                 \
  X(vkEnumerateDeviceExtensionProperties)                                                \
  X(vkCreateDevice)                                                                      \
  X(vkDestroyDevice)                                                                     \
  X(vkGetDeviceQueue)                                                                    \
  X(vkCreateBuffer)                                                                      \
  X(vkDestroyBuffer)                                                                     \
  X(vkGetBufferMemoryRequirements)                                                       \
  X(vkAllocateMemory)                                                                    \
  X(vkFreeMemory)                                                                        \
  X(vkBindBufferMemory)                                                                  \
  X(vkMapMemory)                                                                         \
  X(vkUnmapMemory)                                                                       \
  X(vkCreateDescriptorSetLayout)                                                         \
  X(vkDestroyDescriptorSetLayout)                                                        \
  X(vkCreateDescriptorPool)                                                              \
  X(vkDestroyDescriptorPool)                                                             \
  X(vkAllocateDescriptorSets)                                                            \
  X(vkUpdateDescriptorSets)                                                              \
  X(vkCreatePipelineLayout)                                                              \
  X(vkDestroyPipelineLayout)                                                             \
  X(vkCreateShaderModule)                                                                \
  X(vkDestroyShaderModule)                                                               \
  X(vkCreateComputePipelines)                                                            \
  X(vkDestroyPipeline)                                                                   \
  X(vkCreateCommandPool)                                                                 \
  X(vkDestroyCommandPool)                                                                \
  X(vkAllocateCommandBuffers)                                                            \
  X(vkCreateFence)                                                                       \
  X(vkDestroyFence)                                                                      \
  X(vkResetFences)                                                                       \
  X(vkWaitForFences)                                                                     \
  X(vkCreateQueryPool)                                                                   \
  X(vkDestroyQueryPool)                                                                  \
  X(vkGetQueryPoolResults)                                                               \
  X(vkResetCommandBuffer)                                                                \
  X(vkBeginCommandBuffer)                                                                \
  X(vkEndCommandBuffer)                                                                  \
  X(vkCmdPipelineBarrier)                                                                \
  X(vkCmdCopyBuffer)                                                                     \
  X(vkCmdFillBuffer)                                                                     \
  X(vkCmdBindPipeline)                                                                   \
  X(vkCmdBindDescriptorSets)                                                             \
  X(vkCmdPushConstants)                                                                  \
  X(vkCmdResetQueryPool)                                                                 \
  X(vkCmdWriteTimestamp)                                                                 \
  X(vkCmdDispatch)                                                                       \
  X(vkQueueSubmit)                                                                       \
  X(vkQueueWaitIdle)                                                                     \
  X(vkDeviceWaitIdle)

static void check(VkResult result) {
  if (result != VK_SUCCESS)
    throw std::runtime_error("Vulkan error " + std::to_string(result));
}

static bool hasExtension(const std::vector<VkExtensionProperties> &extensions,
                         const char *name) {
  return std::any_of(extensions.begin(), extensions.end(), [&](const auto &extension) {
    return std::strcmp(extension.extensionName, name) == 0;
  });
}

static PFN_vkGetInstanceProcAddr vulkanLoader() {
  static const Library library(
#if defined(_WIN32)
      {"vulkan-1.dll"},
#elif defined(__APPLE__)
      {"/usr/local/lib/libvulkan.1.dylib", "/opt/homebrew/lib/libvulkan.1.dylib",
       "/usr/local/lib/libMoltenVK.dylib", "/opt/homebrew/lib/libMoltenVK.dylib"},
#else
      {"libvulkan.so.1", "libvulkan.so"},
#endif
      "Vulkan");
  static const auto getInstanceProcAddr = [] {
    PFN_vkGetInstanceProcAddr function;
    library.load(function, "vkGetInstanceProcAddr");
    return function;
  }();
  return getInstanceProcAddr;
}

struct VulkanBuffer {
  VkBuffer handle = VK_NULL_HANDLE;
  VkDeviceMemory memory = VK_NULL_HANDLE;
  uint32_t *data = nullptr;
  size_t size = 0;
};

class VulkanDevice : public Device {
public:
  explicit VulkanDevice(const DeviceOptions &options) {
    backend = "vulkan";
    try {
      init(options);
    } catch (...) {
      destroy();
      throw;
    }
  }

  ~VulkanDevice() override { destroy(); }

  void prepare(uint32_t batch) override {
    if (uint64_t(batch + 63) / 64 > maxWorkGroups)
      throw std::runtime_error("Batch exceeds Vulkan dispatch limits");
  }

  void upload(const uint32_t *config, const uint32_t *table, size_t tableBytes) override {
    if (tableBytes != buffers[1].size)
      throw std::runtime_error("Unexpected basepoint table size");
    std::memcpy(staging[0].data, config, configWords * sizeof(uint32_t));
    std::memcpy(staging[1].data, table, tableBytes);
    uploaded = false;
  }

  void submit(unsigned slot, const Parameters &params) override { record(slot, params); }

  const uint32_t *wait(unsigned slot) override {
    check(vkWaitForFences(device, 1, &fences[slot], VK_TRUE, UINT64_MAX));
    if (timestampPool) {
      uint64_t values[2];
      check(vkGetQueryPoolResults(device, timestampPool, slot * 2, 2, sizeof(values),
                                  values, sizeof(uint64_t),
                                  VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
      const uint64_t mask =
          timestampBits == 64 ? UINT64_MAX : (uint64_t(1) << timestampBits) - 1;
      lastGpuSeconds = double((values[1] - values[0]) & mask) * timestampPeriod * 1e-9;
    }
    return staging[2 + slot].data;
  }

private:
#define VANITY_VULKAN_MEMBER(name) PFN_##name name = nullptr;
  VANITY_VULKAN_INSTANCE_FUNCTIONS(VANITY_VULKAN_MEMBER)
#undef VANITY_VULKAN_MEMBER
  PFN_vkGetPhysicalDeviceFeatures2 vkGetPhysicalDeviceFeatures2 = nullptr;
  PFN_vkGetPhysicalDeviceProperties2 vkGetPhysicalDeviceProperties2 = nullptr;

  VkInstance instance = VK_NULL_HANDLE;
  VkPhysicalDevice physical = VK_NULL_HANDLE;
  VkDevice device = VK_NULL_HANDLE;
  VkQueue queue = VK_NULL_HANDLE;
  VkDescriptorSetLayout layout = VK_NULL_HANDLE;
  VkDescriptorPool descriptors = VK_NULL_HANDLE;
  std::array<VkDescriptorSet, deviceSlots> sets{};
  VkPipelineLayout pipelineLayout = VK_NULL_HANDLE;
  VkShaderModule shader = VK_NULL_HANDLE;
  VkPipeline pipeline = VK_NULL_HANDLE;
  VkCommandPool pool = VK_NULL_HANDLE;
  std::array<VkCommandBuffer, deviceSlots> commandBuffers{};
  std::array<VkFence, deviceSlots> fences{};
  VkQueryPool timestampPool = VK_NULL_HANDLE;
  uint32_t timestampBits = 0, maxWorkGroups = 0;
  double timestampPeriod = 0;
  // 0: configuration, 1: basepoint table, 2 + slot: per-slot results.
  std::array<VulkanBuffer, 2 + deviceSlots> buffers;
  std::array<VulkanBuffer, 2 + deviceSlots> staging;
  bool uploaded = false;

  void destroy() noexcept {
    if (device) {
      vkDeviceWaitIdle(device);
      clearSecrets();

      // Wipe the search key in mapped memory and device configuration.
      for (auto *group : {&staging, &buffers}) {
        for (auto &b : *group) {
          if (b.data) {
            sodium_memzero(b.data, b.size);
            vkUnmapMemory(device, b.memory);
            b.data = nullptr;
          }
          if (b.handle)
            vkDestroyBuffer(device, b.handle, nullptr);
          if (b.memory)
            vkFreeMemory(device, b.memory, nullptr);
          b = VulkanBuffer{};
        }
      }

      if (timestampPool)
        vkDestroyQueryPool(device, timestampPool, nullptr);
      for (auto fence : fences)
        if (fence)
          vkDestroyFence(device, fence, nullptr);
      if (pool)
        vkDestroyCommandPool(device, pool, nullptr);
      if (pipeline)
        vkDestroyPipeline(device, pipeline, nullptr);
      if (shader)
        vkDestroyShaderModule(device, shader, nullptr);
      if (pipelineLayout)
        vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
      if (descriptors)
        vkDestroyDescriptorPool(device, descriptors, nullptr);
      if (layout)
        vkDestroyDescriptorSetLayout(device, layout, nullptr);
      vkDestroyDevice(device, nullptr);
      device = VK_NULL_HANDLE;
    }

    if (instance && vkDestroyInstance)
      vkDestroyInstance(instance, nullptr);
    instance = VK_NULL_HANDLE;
  }

  void loadFunctions() {
    auto getInstanceProcAddr = vulkanLoader();
#define VANITY_VULKAN_LOAD(name)                                                         \
  name = reinterpret_cast<PFN_##name>(getInstanceProcAddr(instance, #name));             \
  if (!name)                                                                             \
    throw std::runtime_error("Vulkan loader is missing " #name);
    VANITY_VULKAN_INSTANCE_FUNCTIONS(VANITY_VULKAN_LOAD)
#undef VANITY_VULKAN_LOAD
    // Core in Vulkan 1.1; only used for the optional AMD subgroup-size path.
    vkGetPhysicalDeviceFeatures2 = reinterpret_cast<PFN_vkGetPhysicalDeviceFeatures2>(
        getInstanceProcAddr(instance, "vkGetPhysicalDeviceFeatures2"));
    vkGetPhysicalDeviceProperties2 = reinterpret_cast<PFN_vkGetPhysicalDeviceProperties2>(
        getInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties2"));
  }

  void buffer(VulkanBuffer &b, size_t size, bool host) {
    b.size = size;

    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    info.size = size;
    info.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT |
                 VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    check(vkCreateBuffer(device, &info, nullptr, &b.handle));

    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, b.handle, &req);

    VkPhysicalDeviceMemoryProperties mem;
    vkGetPhysicalDeviceMemoryProperties(physical, &mem);
    uint32_t index = mem.memoryTypeCount;
    const auto flags =
        host ? VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT
             : VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
    for (uint32_t i = 0; i < mem.memoryTypeCount; i++) {
      if ((req.memoryTypeBits & (1u << i)) &&
          (mem.memoryTypes[i].propertyFlags & flags) == flags) {
        index = i;
        break;
      }
    }
    if (index == mem.memoryTypeCount)
      throw std::runtime_error(host ? "No coherent host-visible Vulkan memory"
                                    : "No device-local Vulkan memory");

    VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    alloc.allocationSize = req.size;
    alloc.memoryTypeIndex = index;
    check(vkAllocateMemory(device, &alloc, nullptr, &b.memory));
    check(vkBindBufferMemory(device, b.handle, b.memory, 0));
    if (host) {
      void *mapped;
      check(vkMapMemory(device, b.memory, 0, size, 0, &mapped));
      b.data = static_cast<uint32_t *>(mapped);
      std::memset(b.data, 0, size);
    }
  }

  void init(const DeviceOptions &options) {
    auto vkCreateInstance = reinterpret_cast<PFN_vkCreateInstance>(
        vulkanLoader()(VK_NULL_HANDLE, "vkCreateInstance"));
    if (!vkCreateInstance)
      throw std::runtime_error("Vulkan loader is missing vkCreateInstance");

    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "Pear vanity";
    app.apiVersion = VK_API_VERSION_1_1;

    VkInstanceCreateInfo info{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    info.pApplicationInfo = &app;
    // MoltenVK and other layered drivers are only listed when the application
    // opts into portability enumeration.
    // VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR, absent from older headers.
    constexpr VkInstanceCreateFlags enumeratePortability = 0x00000001;
    const char *portabilityEnumeration = "VK_KHR_portability_enumeration";
    auto vkEnumerateInstanceExtensionProperties =
        reinterpret_cast<PFN_vkEnumerateInstanceExtensionProperties>(
            vulkanLoader()(VK_NULL_HANDLE, "vkEnumerateInstanceExtensionProperties"));
    if (vkEnumerateInstanceExtensionProperties) {
      uint32_t extensionCount = 0;
      if (vkEnumerateInstanceExtensionProperties(nullptr, &extensionCount, nullptr) ==
          VK_SUCCESS) {
        std::vector<VkExtensionProperties> extensions(extensionCount);
        if (vkEnumerateInstanceExtensionProperties(nullptr, &extensionCount,
                                                   extensions.data()) == VK_SUCCESS &&
            hasExtension(extensions, portabilityEnumeration)) {
          info.flags |= enumeratePortability;
          info.enabledExtensionCount = 1;
          info.ppEnabledExtensionNames = &portabilityEnumeration;
        }
      }
    }
    check(vkCreateInstance(&info, nullptr, &instance));
    loadFunctions();
    uint32_t count = 0;
    check(vkEnumeratePhysicalDevices(instance, &count, nullptr));
    std::vector<VkPhysicalDevice> devices(count);
    check(vkEnumeratePhysicalDevices(instance, &count, devices.data()));
    uint32_t family = 0;
    int best = -1;
    for (auto candidate : devices) {
      VkPhysicalDeviceFeatures features;
      VkPhysicalDeviceProperties props;
      vkGetPhysicalDeviceFeatures(candidate, &features);
      vkGetPhysicalDeviceProperties(candidate, &props);
      if (props.apiVersion < VK_API_VERSION_1_1)
        continue;
      if (!features.shaderInt64 ||
          (!options.software && props.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU))
        continue;
      if (props.limits.maxComputeWorkGroupInvocations < 64 ||
          props.limits.maxComputeWorkGroupSize[0] < 64)
        continue;
      int score = props.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU     ? 3
                  : props.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ? 2
                                                                               : 1;
      uint32_t n = 0;
      vkGetPhysicalDeviceQueueFamilyProperties(candidate, &n, nullptr);
      std::vector<VkQueueFamilyProperties> queues(n);
      vkGetPhysicalDeviceQueueFamilyProperties(candidate, &n, queues.data());
      for (uint32_t i = 0; i < n; i++) {
        if ((queues[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && score > best) {
          physical = candidate;
          family = i;
          best = score;
          timestampBits = queues[i].timestampValidBits;
        }
      }
    }
    if (!physical)
      throw std::runtime_error("No Vulkan GPU with shaderInt64 support");
    VkPhysicalDeviceProperties selected;
    vkGetPhysicalDeviceProperties(physical, &selected);
    name = selected.deviceName;
    timestampPeriod = selected.limits.timestampPeriod;
    maxWorkGroups = selected.limits.maxComputeWorkGroupCount[0];
    software = selected.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU;
    const char *subgroupExtension = VK_EXT_SUBGROUP_SIZE_CONTROL_EXTENSION_NAME;
    VkPhysicalDeviceSubgroupSizeControlFeaturesEXT subgroupFeatures{
        VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_FEATURES_EXT};
    uint32_t extensionCount = 0;
    check(vkEnumerateDeviceExtensionProperties(physical, nullptr, &extensionCount,
                                               nullptr));
    std::vector<VkExtensionProperties> extensions(extensionCount);
    check(vkEnumerateDeviceExtensionProperties(physical, nullptr, &extensionCount,
                                               extensions.data()));
    if (options.mode == 0 && selected.vendorID == 0x1002 &&
        vkGetPhysicalDeviceFeatures2 && vkGetPhysicalDeviceProperties2) {
      if (hasExtension(extensions, subgroupExtension)) {
        VkPhysicalDeviceFeatures2 available{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
        available.pNext = &subgroupFeatures;
        vkGetPhysicalDeviceFeatures2(physical, &available);
        VkPhysicalDeviceSubgroupSizeControlPropertiesEXT subgroupProperties{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_PROPERTIES_EXT};
        VkPhysicalDeviceProperties2 properties{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2};
        properties.pNext = &subgroupProperties;
        vkGetPhysicalDeviceProperties2(physical, &properties);
        if (subgroupFeatures.subgroupSizeControl &&
            subgroupProperties.minSubgroupSize <= 32 &&
            subgroupProperties.maxSubgroupSize >= 32 &&
            subgroupProperties.maxComputeWorkgroupSubgroups >= 2 &&
            (subgroupProperties.requiredSubgroupSizeStages & VK_SHADER_STAGE_COMPUTE_BIT))
          requiredSubgroupSize = 32;
      }
    }
    subgroupFeatures.computeFullSubgroups = VK_FALSE;
    float priority = 1;

    VkDeviceQueueCreateInfo q{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    q.queueFamilyIndex = family;
    q.queueCount = 1;
    q.pQueuePriorities = &priority;
    VkPhysicalDeviceFeatures features{};
    features.shaderInt64 = VK_TRUE;

    VkDeviceCreateInfo d{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    d.queueCreateInfoCount = 1;
    d.pQueueCreateInfos = &q;
    d.pEnabledFeatures = &features;
    std::vector<const char *> enabled;
    if (requiredSubgroupSize) {
      d.pNext = &subgroupFeatures;
      enabled.push_back(subgroupExtension);
    }
    // Portability drivers such as MoltenVK require this extension when listed.
    if (hasExtension(extensions, "VK_KHR_portability_subset"))
      enabled.push_back("VK_KHR_portability_subset");
    d.enabledExtensionCount = uint32_t(enabled.size());
    d.ppEnabledExtensionNames = enabled.data();
    check(vkCreateDevice(physical, &d, nullptr, &device));
    vkGetDeviceQueue(device, family, 0, &queue);
    for (uint32_t i = 0; i < buffers.size(); i++) {
      const size_t size = i == 0   ? configWords * sizeof(uint32_t)
                          : i == 1 ? sizeof(basepoint_table)
                                   : resultWords * sizeof(uint32_t);
      buffer(buffers[i], size, false);
      buffer(staging[i], size, true);
    }
    std::array<VkDescriptorSetLayoutBinding, 3> bindings{};
    for (uint32_t i = 0; i < 3; i++) {
      bindings[i].binding = i;
      bindings[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
      bindings[i].descriptorCount = 1;
      bindings[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    }

    VkDescriptorSetLayoutCreateInfo l{
        VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    l.bindingCount = 3;
    l.pBindings = bindings.data();
    check(vkCreateDescriptorSetLayout(device, &l, nullptr, &layout));
    VkDescriptorPoolSize ps{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3 * deviceSlots};

    VkDescriptorPoolCreateInfo dp{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    dp.maxSets = deviceSlots;
    dp.poolSizeCount = 1;
    dp.pPoolSizes = &ps;
    check(vkCreateDescriptorPool(device, &dp, nullptr, &descriptors));

    // Each slot binds the shared configuration and table plus its own results.
    for (uint32_t slot = 0; slot < deviceSlots; slot++) {
      VkDescriptorSetAllocateInfo ds{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
      ds.descriptorPool = descriptors;
      ds.descriptorSetCount = 1;
      ds.pSetLayouts = &layout;
      check(vkAllocateDescriptorSets(device, &ds, &sets[slot]));
      std::array<VkDescriptorBufferInfo, 3> bi{};
      std::array<VkWriteDescriptorSet, 3> writes{};
      for (uint32_t i = 0; i < 3; i++) {
        const auto &target = buffers[i == 2 ? 2 + slot : i];
        bi[i] = {target.handle, 0, target.size};
        writes[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        writes[i].dstSet = sets[slot];
        writes[i].dstBinding = i;
        writes[i].descriptorCount = 1;
        writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        writes[i].pBufferInfo = &bi[i];
      }
      vkUpdateDescriptorSets(device, 3, writes.data(), 0, nullptr);
    }
    VkPushConstantRange range{VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(Parameters)};

    VkPipelineLayoutCreateInfo pl{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    pl.setLayoutCount = 1;
    pl.pSetLayouts = &layout;
    pl.pushConstantRangeCount = 1;
    pl.pPushConstantRanges = &range;
    check(vkCreatePipelineLayout(device, &pl, nullptr, &pipelineLayout));

    VkShaderModuleCreateInfo sm{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    sm.codeSize = options.mode == 0 ? sizeof(touch_shader) : sizeof(multisig_shader);
    sm.pCode = options.mode == 0 ? touch_shader : multisig_shader;
    check(vkCreateShaderModule(device, &sm, nullptr, &shader));

    VkComputePipelineCreateInfo cp{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    cp.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    cp.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    cp.stage.module = shader;
    cp.stage.pName = "main";
    VkPipelineShaderStageRequiredSubgroupSizeCreateInfoEXT subgroupStage{
        VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_REQUIRED_SUBGROUP_SIZE_CREATE_INFO_EXT};
    if (requiredSubgroupSize) {
      subgroupStage.requiredSubgroupSize = requiredSubgroupSize;
      cp.stage.pNext = &subgroupStage;
    }
    cp.layout = pipelineLayout;
    check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cp, nullptr, &pipeline));

    VkCommandPoolCreateInfo pc{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
    pc.queueFamilyIndex = family;
    pc.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    check(vkCreateCommandPool(device, &pc, nullptr, &pool));

    VkCommandBufferAllocateInfo ca{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    ca.commandPool = pool;
    ca.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    ca.commandBufferCount = deviceSlots;
    check(vkAllocateCommandBuffers(device, &ca, commandBuffers.data()));

    VkFenceCreateInfo fc{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    for (auto &fence : fences)
      check(vkCreateFence(device, &fc, nullptr, &fence));
    if (options.benchmark && timestampBits) {
      VkQueryPoolCreateInfo query{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
      query.queryType = VK_QUERY_TYPE_TIMESTAMP;
      query.queryCount = 2 * deviceSlots;
      check(vkCreateQueryPool(device, &query, nullptr, &timestampPool));
      timestamps = true;
    }
  }

  // Records and submits one slot's dispatch. Barriers order it after every
  // earlier submission, including the one-time configuration upload.
  void record(unsigned slot, const Parameters &params) {
    VkCommandBuffer commands = commandBuffers[slot];
    VulkanBuffer &results = buffers[2 + slot];
    check(vkResetCommandBuffer(commands, 0));

    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vkBeginCommandBuffer(commands, &begin));

    VkMemoryBarrier hostWrites{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    hostWrites.srcAccessMask = VK_ACCESS_HOST_WRITE_BIT;
    hostWrites.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_HOST_BIT,
                         VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &hostWrites, 0, nullptr, 0,
                         nullptr);
    if (!uploaded) {
      for (uint32_t i : {0u, 1u}) {
        VkBufferCopy copy{0, 0, buffers[i].size};
        vkCmdCopyBuffer(commands, staging[i].handle, buffers[i].handle, 1, &copy);
      }
    }
    vkCmdFillBuffer(commands, results.handle, 0, sizeof(uint32_t), UINT32_MAX);

    VkMemoryBarrier before{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    before.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    before.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT;
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &before, 0, nullptr,
                         0, nullptr);
    vkCmdBindPipeline(commands, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(commands, VK_PIPELINE_BIND_POINT_COMPUTE, pipelineLayout, 0,
                            1, &sets[slot], 0, nullptr);
    vkCmdPushConstants(commands, pipelineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0,
                       sizeof(params), &params);
    if (timestampPool) {
      vkCmdResetQueryPool(commands, timestampPool, slot * 2, 2);
      vkCmdWriteTimestamp(commands, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, timestampPool,
                          slot * 2);
    }
    vkCmdDispatch(commands, (params.count + 63) / 64, 1, 1);
    if (timestampPool)
      vkCmdWriteTimestamp(commands, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, timestampPool,
                          slot * 2 + 1);

    VkMemoryBarrier after{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    after.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    after.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &after, 0, nullptr, 0,
                         nullptr);

    VkBufferCopy readback{0, 0, results.size};
    vkCmdCopyBuffer(commands, results.handle, staging[2 + slot].handle, 1, &readback);

    VkMemoryBarrier hostReads{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    hostReads.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    hostReads.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &hostReads, 0, nullptr, 0,
                         nullptr);
    check(vkEndCommandBuffer(commands));
    check(vkResetFences(device, 1, &fences[slot]));

    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &commands;
    check(vkQueueSubmit(queue, 1, &submit, fences[slot]));
    uploaded = true;
  }

  void clearSecrets() noexcept {
    VkCommandBuffer commands = commandBuffers[0];
    if (!commands || !buffers[0].handle || !queue)
      return;
    if (vkResetCommandBuffer(commands, 0) != VK_SUCCESS)
      return;

    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    if (vkBeginCommandBuffer(commands, &begin) != VK_SUCCESS)
      return;
    vkCmdFillBuffer(commands, buffers[0].handle, 0, buffers[0].size, 0);
    if (vkEndCommandBuffer(commands) != VK_SUCCESS)
      return;

    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &commands;
    if (vkQueueSubmit(queue, 1, &submit, VK_NULL_HANDLE) == VK_SUCCESS)
      vkQueueWaitIdle(queue);
  }
};
