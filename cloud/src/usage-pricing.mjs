// USD per million tokens, from the product model prices. This is an estimate, not provider settlement.
export const MODEL_PRICES={
  "anthropic/claude-haiku-5.5":{input:.1,cacheRead:.01,output:.5},
  "anthropic/claude-opus-5.5":{input:4,cacheRead:.2,output:20,cacheWrite:5,cacheWrite1h:8},
  "z-ai/glm-5.3-flash":{input:.15,cacheRead:.03,output:.5},
  "z-ai/glm-5.3-flashx":{input:.375,cacheRead:.075,output:1.25},
};
export function estimateUsageCost(model,usage={}) {
  const prices=MODEL_PRICES[model];if(!prices)throw new Error("不支持的模型");
  const input=usage.input_tokens||0,read=usage.cache_read_input_tokens||0,write=usage.cache_creation_input_tokens||0,output=usage.output_tokens||0;
  const multiplier=model==="anthropic/claude-haiku-5.5"&&input+read+write>100_000?5:1;
  // Without a TTL breakdown, estimate Opus writes at 5 minutes; unspecified model write prices use input.
  const write1h=Math.min(write,usage.cache_creation?.ephemeral_1h_input_tokens||0);
  const writeCost=(write-write1h)*(prices.cacheWrite??prices.input)+write1h*(prices.cacheWrite1h??prices.input);
  return (input*prices.input+writeCost+read*prices.cacheRead+output*prices.output)*multiplier/1_000_000;
}
