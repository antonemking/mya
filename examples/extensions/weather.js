/** Adds a tool the model can call. Core knows nothing about it. */
export default {
  name: "weather",
  tools: [
    {
      name: "weather",
      description: "Report the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name." } },
        required: ["city"],
        additionalProperties: false,
      },
      execute(args) {
        return { output: `${args.city}: 14°C, light rain, wind 12 km/h` };
      },
    },
  ],
};
