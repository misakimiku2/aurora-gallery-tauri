/**
 * `.aurora` 工程文件的前端映射单测。
 *
 * 锁的是**往返不丢语义**：文档 → 保存请求 → （Rust 存盘读回）→ 文档，几何与调色
 * 必须一模一样，且脏标记/版本号被正确复位。Rust 侧的字节级往返由
 * `core/src/editor_project.rs` 的单测负责，这里只管形状。
 */
import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorLayer, LayerBox } from '../../../types';
import { createIdentityBox, EDITOR_DOC_VERSION } from '../layerModel';
import {
  buildSavePayload,
  defaultProjectPath,
  formatBytes,
  isProjectPath,
  projectDisplayName,
  projectPayloadToDocument,
  type OpenedProjectPayload,
} from '../projectFile';

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  ...createIdentityBox(200, 100),
  ...over,
});

const layer = (over: Partial<EditorLayer> = {}): EditorLayer => ({
  id: 'l1',
  kind: 'image',
  source: 'C:\\pics\\a.jpg',
  naturalWidth: 200,
  naturalHeight: 100,
  box: box(),
  visible: true,
  name: '图层 1',
  ...over,
});

const doc = (over: Partial<EditorDocument> = {}): EditorDocument => ({
  path: 'C:\\pics\\a.jpg',
  name: 'a',
  dirty: true,
  version: EDITOR_DOC_VERSION,
  canvas: { width: 400, height: 300, background: 'white' },
  layers: [layer()],
  activeLayerId: 'l1',
  ...over,
});

/** 模拟 Rust 侧 `editor_open_project` 的返回：读回来的就是存进去的。 */
function roundTrip(source: EditorDocument): OpenedProjectPayload {
  const payload = buildSavePayload(source);
  return {
    name: payload.name,
    canvas: payload.canvas,
    layers: payload.layers.map(l => ({ ...l, source: l.source })),
    activeLayerId: payload.activeLayerId,
    source: 'editor',
    warnings: [],
  };
}

describe('buildSavePayload', () => {
  it('画出画布、图层与活动层', () => {
    const payload = buildSavePayload(doc());
    expect(payload.canvas).toEqual({ width: 400, height: 300, background: 'white' });
    expect(payload.layers).toHaveLength(1);
    expect(payload.activeLayerId).toBe('l1');
  });

  it('画布缺失或为 0 时抛错，而不是存一份坏文档', () => {
    expect(() => buildSavePayload(doc({ canvas: undefined }))).toThrow(/画布尺寸无效/);
    expect(() => buildSavePayload(doc({ canvas: { width: 0, height: 100, background: 'white' } }))).toThrow();
  });

  it('丢弃没有源图的图层', () => {
    const payload = buildSavePayload(
      doc({ layers: [layer({ source: undefined, id: 'ghost' }), layer({ id: 'ok' })] }),
    );
    expect(payload.layers.map(l => l.id)).toEqual(['ok']);
    // 活动层指向被丢掉的层时不能悬空
    expect(payload.activeLayerId).toBeNull();
  });

  it('没有调色时 adjust 落成 null（而不是 undefined，JSON 里要显式）', () => {
    const payload = buildSavePayload(doc());
    expect(payload.layers[0].adjust).toBeNull();
  });
});

describe('projectPayloadToDocument', () => {
  it('几何与调色往返不变', () => {
    const source = doc({
      layers: [
        layer({
          box: box({ x: 12.5, y: -3.25, w: 200, h: 100, rotation: 45, flipH: true }),
          adjust: { brightness: 20, contrast: -10, saturation: 5, temperature: 0 },
        }),
      ],
    });
    const back = projectPayloadToDocument(roundTrip(source), 'C:\\pics\\a.aurora');

    expect(back.path).toBe('C:\\pics\\a.aurora');
    expect(back.dirty).toBe(false);
    expect(back.version).toBe(EDITOR_DOC_VERSION);
    expect(back.canvas).toEqual({ width: 400, height: 300, background: 'white' });
    expect(back.layers?.[0].box).toEqual(source.layers![0].box);
    expect(back.layers?.[0].adjust).toEqual(source.layers![0].adjust);
    expect(back.activeLayerId).toBe('l1');
  });

  it('非法画布被夹到 1×1，未知背景退回透明', () => {
    const back = projectPayloadToDocument(
      {
        name: 'x',
        canvas: { width: 0, height: Number.NaN, background: 'pink' as never },
        layers: [],
        activeLayerId: null,
        source: 'editor',
        warnings: [],
      },
      'C:\\x.aurora',
    );
    expect(back.canvas).toEqual({ width: 1, height: 1, background: 'transparent' });
  });

  it('全 0 的 adjust 不落成空对象', () => {
    const back = projectPayloadToDocument(
      {
        name: 'x',
        canvas: { width: 10, height: 10, background: 'white' },
        layers: [
          {
            id: 'l1',
            name: '层',
            source: 'C:\\a.png',
            naturalWidth: 10,
            naturalHeight: 10,
            visible: true,
            box: box(),
            adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
          },
        ],
        activeLayerId: null,
        source: 'editor',
        warnings: [],
      },
      'C:\\x.aurora',
    );
    expect(back.layers?.[0].adjust).toBeUndefined();
    // 没有明确活动层时落到最上面一层（与 resolveActiveLayer 的兜底一致）
    expect(back.activeLayerId).toBe('l1');
  });

  it('名字缺失时用文件名兜底', () => {
    const back = projectPayloadToDocument(
      {
        name: '   ',
        canvas: { width: 10, height: 10, background: 'white' },
        layers: [],
        activeLayerId: null,
        source: 'editor',
        warnings: [],
      },
      'C:\\pics\\封面稿.aurora',
    );
    expect(back.name).toBe('封面稿');
  });
});

describe('路径小工具', () => {
  it('只认 .aurora（大小写不敏感）', () => {
    expect(isProjectPath('C:\\a\\b.aurora')).toBe(true);
    expect(isProjectPath('C:\\a\\b.AURORA')).toBe(true);
    expect(isProjectPath('C:\\a\\b.png')).toBe(false);
    expect(isProjectPath(undefined)).toBe(false);
  });

  it('保存默认路径 = 同目录同名换扩展名', () => {
    expect(defaultProjectPath(doc({ path: 'C:\\pics\\a.jpg' }))).toBe('C:\\pics\\a.aurora');
    expect(defaultProjectPath(doc({ path: '/home/u/a.png' }))).toBe('/home/u/a.aurora');
    // 空白文档没有 path：交给系统上次目录，不瞎猜
    expect(defaultProjectPath(doc({ path: undefined }))).toBe('');
  });

  it('标题取文件名去扩展名', () => {
    expect(projectDisplayName('C:\\pics\\封面.aurora')).toBe('封面');
    expect(projectDisplayName('C:\\pics\\.aurora')).toBe('未命名');
  });

  it('不透明度往返不丢；回到 100 时折成 undefined', () => {
    const half = roundTrip(doc({ layers: [layer({ opacity: 40 })] }));
    expect(projectPayloadToDocument(half, 'C:////pics////a.aurora').layers?.[0].opacity).toBe(40);

    // 保存时显式写 100（不是省掉），但读回来要折成 undefined，文档保持干净
    const payload = buildSavePayload(doc({ layers: [layer()] }));
    expect(payload.layers[0].opacity).toBe(100);
    expect(
      projectPayloadToDocument(roundTrip(doc({ layers: [layer()] })), 'x.aurora').layers?.[0].opacity,
    ).toBeUndefined();
  });

  it('老工程没有 opacity 字段时按完全不透明读', () => {
    const legacy = roundTrip(doc({ layers: [layer()] }));
    delete (legacy.layers[0] as { opacity?: number }).opacity;
    expect(projectPayloadToDocument(legacy, 'x.aurora').layers?.[0].opacity).toBeUndefined();
  });

  it('混合模式往返不丢；normal 不落字段', () => {
    const multiplied = roundTrip(doc({ layers: [layer({ blend: 'multiply' })] }));
    expect(projectPayloadToDocument(multiplied, 'x.aurora').layers?.[0].blend).toBe('multiply');

    // 保存时显式写 normal，读回来折成 undefined（文档保持干净）
    const payload = buildSavePayload(doc({ layers: [layer()] }));
    expect(payload.layers[0].blend).toBe('normal');
    expect(projectPayloadToDocument(roundTrip(doc()), 'x.aurora').layers?.[0].blend).toBeUndefined();
  });

  it('老工程没有 blend 字段时按正常读', () => {
    const legacy = roundTrip(doc({ layers: [layer()] }));
    delete (legacy.layers[0] as { blend?: string }).blend;
    expect(projectPayloadToDocument(legacy, 'x.aurora').layers?.[0].blend).toBeUndefined();
  });

  it('锁状态往返；未锁不落字段', () => {
    const locked = roundTrip(doc({ layers: [layer({ lockPixel: true, lockPosition: true })] }));
    const opened = projectPayloadToDocument(locked, 'x.aurora').layers?.[0];
    expect(opened?.lockPixel).toBe(true);
    expect(opened?.lockPosition).toBe(true);

    // 未锁：保存时显式写 false，读回来折成 undefined（文档保持干净）
    const payload = buildSavePayload(doc({ layers: [layer()] }));
    expect(payload.layers[0].lock_pixel).toBe(false);
    expect(projectPayloadToDocument(roundTrip(doc()), 'x.aurora').layers?.[0].lockPixel).toBeUndefined();
  });

  it('老工程没有锁字段时按未锁读', () => {
    const legacy = roundTrip(doc({ layers: [layer()] }));
    delete (legacy.layers[0] as { lock_pixel?: boolean }).lock_pixel;
    delete (legacy.layers[0] as { lock_position?: boolean }).lock_position;
    const opened = projectPayloadToDocument(legacy, 'x.aurora').layers?.[0];
    expect(opened?.lockPixel).toBeUndefined();
    expect(opened?.lockPosition).toBeUndefined();
  });

  it('字节格式化', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(52 * 1024 * 1024)).toBe('52.0 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
});
