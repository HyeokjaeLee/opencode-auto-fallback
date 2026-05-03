export function formatModelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

export function isSameModel(
  a: { providerID: string; modelID: string },
  b: { providerID: string; modelID: string },
): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}
