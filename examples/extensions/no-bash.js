/**
 * Refuses every bash call. The refusal text becomes the tool result, so the
 * next model call can see why the command did not run.
 */
export default {
  name: "no-bash",
  beforeToolCall({ call }) {
    if (call.name !== "bash") return undefined;
    return {
      output: `bash is disabled in this workspace by the no-bash extension. Refused command: ${
        call.arguments?.command ?? call.rawArguments
      }`,
      isError: true,
    };
  },
};
