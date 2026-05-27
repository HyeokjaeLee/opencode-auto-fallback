export function buildSyntheticContinuationPart(text: string) {
  return {
    type: "text" as const,
    text,
    synthetic: true,
  };
}
