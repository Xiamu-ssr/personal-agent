// USD per million tokens, from the v0.6 product contract. This is an estimate, not provider settlement.
export const MODEL_PRICES={
  "anthropic/claude-haiku-5.5":{input:.1,cacheRead:.01,output:.5},
  "z-ai/glm-5.3-flash":{input:.15,cacheRead:.03,output:.5},
  "z-ai/glm-5.3-flashx":{input:.375,cacheRead:.075,output:1.25},
};
export function estimateUsageCost(model,usage={}) {
  const prices=MODEL_PRICES[model];if(!prices)throw new Error("不支持的模型");
  const input=usage.input_tokens||0,read=usage.cache_read_input_tokens||0,write=usage.cache_creation_input_tokens||0,output=usage.output_tokens||0;
  const multiplier=model==="anthropic/claude-haiku-5.5"&&input+read+write>100_000?5:1;
  // The contract does not specify cache-write pricing; count it as input for this estimate.
  return ((input+write)*prices.input+read*prices.cacheRead+output*prices.output)*multiplier/1_000_000;
}
