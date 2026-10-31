# The cargo feature that puts speech on the GPU on this machine, for the local
# builds (docs/voice_gpu_plan.md). Prints nothing where it cannot be built: that
# build still works, its Chat just says CPU, and a warning says why. CI names
# its feature itself (.github/workflows/ci-cd.yml).
voice_gpu_feature() {
  case "$(uname -s)" in
    Darwin) echo voice-metal ;;
    Linux)
      if [[ -z "${VULKAN_SDK:-}" ]] && { ! command -v glslc >/dev/null || [[ ! -e /usr/include/vulkan/vulkan.h ]]; }; then
        echo "voice_gpu: no glslc or Vulkan headers, so speech stays on the CPU in this build (sudo apt install glslc libvulkan-dev)." >&2
      else
        echo voice-vulkan
      fi
      ;;
  esac
}
