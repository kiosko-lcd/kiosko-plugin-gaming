import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWidget, widgetState } from '@kiosko/sdk/testing';
import plugin, { coolingWidget, demoCooling, demoFrames, fps } from './index.ts';
import { COOLING_SOURCE, FRAMES_SOURCE, type FrameSnapshot } from './types.ts';

const idleFrames: FrameSnapshot = { running: false, frameTimes: [], at: 0 };

test('the FPS widget: big average, 1 % low, frame-time curve; hidden and idle with no game', () => {
  const r = renderWidget(fps, { size: { w: 960, h: 462 } });
  assert.equal(r.error, undefined);
  assert.equal(r.outside, 0);
  const demo = demoFrames(0);
  assert.ok(r.texts.includes(String(Math.round(demo.fps!))), r.texts.join('|'));
  assert.ok(r.texts.includes(String(Math.round(demo.low1!))));
  assert.ok(r.texts.some((t) => /^worst \d+\.\d ms$/.test(t)), 'the worst frame under the curve');
  assert.equal(widgetState(fps, 'empty'), false);
  assert.equal(widgetState(fps, 'idle'), false);
  assert.equal(widgetState(fps, 'empty', { sources: { [FRAMES_SOURCE]: idleFrames } }), true);
  assert.equal(widgetState(fps, 'idle', { sources: { [FRAMES_SOURCE]: idleFrames } }), true);
  assert.equal(fps.hideWhenEmpty, true);
  const none = renderWidget(fps, { size: { w: 640, h: 462 }, sources: { [FRAMES_SOURCE]: idleFrames }, locale: 'es' });
  assert.deepEqual(none.texts, ['ningún juego en marcha']);
  const why = renderWidget(fps, { size: { w: 640, h: 462 }, sources: { [FRAMES_SOURCE]: { ...idleFrames, reason: 'x', reasonText: { en: 'MangoHud log folder not found: /x', es: 'No está la carpeta de registros de MangoHud: /x' } } }, locale: 'es' });
  assert.deepEqual(why.texts, ['No está la carpeta de registros de MangoHud: /x']);
});

test('the FPS widget turns amber and red only under the thresholds', () => {
  const low = { ...demoFrames(0), fps: 42, low1: 22 };
  const r = renderWidget(fps, { size: { w: 960, h: 462 }, sources: { [FRAMES_SOURCE]: low }, options: { fpsWarn: 50, fpsAlert: 30 } });
  assert.equal(r.error, undefined);
  assert.ok(r.texts.includes('42') && r.texts.includes('22'));
});

test('the cooling widget: coolant, pump and fans with duty; keeps the tile when the pump stops', () => {
  const r = renderWidget(coolingWidget, { size: { w: 640, h: 462 }, locale: 'de' });
  assert.equal(r.error, undefined);
  assert.equal(r.outside, 0);
  assert.ok(r.texts.includes('33.4'));
  assert.ok(r.texts.includes('2650'));
  assert.ok(r.texts.includes('70%'));
  assert.equal(widgetState(coolingWidget, 'urgent'), false);
  assert.equal(widgetState(coolingWidget, 'idle'), true, 'all calm: nothing to light the panel for');
  const demo = demoCooling(0);
  const stopped = { ...demo, fans: demo.fans.map((f) => (f.kind === 'pump' ? { ...f, rpm: 0 } : f)) };
  assert.equal(widgetState(coolingWidget, 'urgent', { sources: { [COOLING_SOURCE]: stopped } }), true);
  const warm = { ...demo, coolant: [{ ...demo.coolant[0]!, temp: 41.5 }] };
  assert.equal(widgetState(coolingWidget, 'urgent', { sources: { [COOLING_SOURCE]: warm } }), false);
  assert.equal(widgetState(coolingWidget, 'idle', { sources: { [COOLING_SOURCE]: warm } }), false);
  // Many fans in a small tile: as many as fit, then "+N more".
  const many = { ...demo, fans: Array.from({ length: 14 }, (_, i) => ({ ...demo.fans[2]!, id: `f${i}`, name: `Fan ${i + 1}` })) };
  const m = renderWidget(coolingWidget, { size: { w: 320, h: 230 }, sources: { [COOLING_SOURCE]: many } });
  const shown = m.texts.filter((t) => t === '870').length;
  assert.ok(shown > 0 && shown < 14, `${shown} of 14 fans shown, the rest as "+N more"`);
  assert.equal(m.outside, 0);
  const off = renderWidget(coolingWidget, { size: { w: 640, h: 230 }, sources: { [COOLING_SOURCE]: { available: false, reason: 'no cooling tool set', backends: [], fans: [], coolant: [], at: 0 } } });
  assert.deepEqual(off.texts, ['no cooling tool set']);
  // Empty: no sensor at all, or none passes the filter; never with readings, nor before the first read.
  assert.equal(widgetState(coolingWidget, 'empty'), false);
  assert.equal(widgetState(coolingWidget, 'empty', { sources: { [COOLING_SOURCE]: stopped } }), false, 'a stopped pump is the alarm');
  assert.equal(widgetState(coolingWidget, 'empty', { sources: { [COOLING_SOURCE]: { available: false, reason: 'no cooling tool set', backends: [], fans: [], coolant: [], at: 0 } } }), true);
  assert.equal(widgetState(coolingWidget, 'empty', { options: { sensors: ['nothing-here'] } }), true, 'none passes the filter');
  assert.equal(widgetState(coolingWidget, 'empty', { sources: {} }), false, 'no read yet: loading');
});

test('conventions: thresholds in pairs, no takeOver option, a Gaming page template', () => {
  for (const w of plugin.widgets!) assert.equal('takeOver' in (w.options as { props: object }).props, false);
  const props = (coolingWidget.options as { props: Record<string, { unit?: string }> }).props;
  assert.equal(props.tempWarn!.unit, '°C');
  assert.equal(props.tempAlert!.unit, '°C');
  assert.deepEqual(
    plugin.templates![0]!.wide.map((t) => t.widgets[0]),
    ['fps', 'cooling', 'core/clock'],
  );
  assert.deepEqual(plugin.languages, ['en', 'es', 'de', 'zh-Hant', 'zh-Hans']);
});
