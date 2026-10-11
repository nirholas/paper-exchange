import { ColorType, createChart, CrosshairMode, type DeepPartial, type ChartOptions, type IChartApi } from 'lightweight-charts';

export const COLORS = { up: '#2fe3c2', down: '#ed7088', text: '#8b98a3', grid: 'rgba(255,255,255,0.045)', border: '#1b2b2f', accent: '#50d2c1' };

export function baseChart(el: HTMLElement, extra: DeepPartial<ChartOptions> = {}): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: COLORS.text, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: COLORS.border },
    timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
    crosshair: { mode: CrosshairMode.Normal },
    ...extra,
  });
}
