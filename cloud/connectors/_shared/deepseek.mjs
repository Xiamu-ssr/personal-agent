// One balance contract for the Search connector and the model-provider card.
export function deepseekBalance(body) {
  if (typeof body?.is_available !== "boolean" || !Array.isArray(body.balance_infos) || !body.balance_infos.length) {
    throw new Error("DeepSeek 返回的余额格式不正确");
  }
  return body.balance_infos.map(row => {
    if (!["CNY", "USD"].includes(row?.currency) || typeof row.total_balance !== "string" ||
        !/^-?\d+(?:\.\d+)?$/.test(row.total_balance) || !Number.isFinite(Number(row.total_balance))) {
      throw new Error("DeepSeek 返回的余额格式不正确");
    }
    return { currency: row.currency, remaining: Math.max(0, Number(row.total_balance)) };
  });
}
