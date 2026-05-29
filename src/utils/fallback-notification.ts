export function buildSyntheticContinuationPart(text: string): {
  type: "text";
  text: string;
  synthetic: boolean;
} {
  return {
    type: "text" as const,
    text,
    synthetic: true,
  };
}
