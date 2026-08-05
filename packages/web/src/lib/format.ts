/** 站点的总榜热度分能到千亿，原样铺在表格里一列都看不清，按亿/万缩写。 */
export function formatHeat(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)} 亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)} 万`;
  return String(value);
}
