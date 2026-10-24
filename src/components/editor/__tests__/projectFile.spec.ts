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

/** 蒙版夹具：独立于图层的一张小图 */
const mask = (over: Partial<NonNullable<EditorLayer['mask']>> = {}): NonNullable<EditorLayer['mask']> => ({
  source: 'C:\\pics\\m.png',
  naturalWidth: 64,
  naturalHeight: 32,
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

/** 模拟 Rust 侧 `editor_open_project` 的返回：读回来的就是存进去的
 * （source 可为 null = 组行；蒙版自然尺寸按解压文件回读）。 */
function roundTrip(source: EditorDocument): OpenedProjectPayload {
  const payload = buildSavePayload(source);
  return {
    name: payload.name,
    canvas: payload.canvas,
    layers: payload.layers.map(l => ({
      ...l,
      source: l.source || null,
      maskNaturalWidth: l.maskSource ? 64 : 0,
      maskNaturalHeight: l.maskSource ? 32 : 0,
    })),
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
    const locked = roundTrip(
      doc({ layers: [layer({ lockTransparent: true, lockPixel: true, lockPosition: true })] }),
    );
    const opened = projectPayloadToDocument(locked, 'x.aurora').layers?.[0];
    expect(opened?.lockTransparent).toBe(true);
    expect(opened?.lockPixel).toBe(true);
    expect(opened?.lockPosition).toBe(true);
    expect(locked.layers[0].lockTransparent).toBe(true);

    // 未锁：保存时显式写 false，读回来折成 undefined（文档保持干净）
    const payload = buildSavePayload(doc({ layers: [layer()] }));
    expect(payload.layers[0].lockPixel).toBe(false);
    expect(projectPayloadToDocument(roundTrip(doc()), 'x.aurora').layers?.[0].lockPixel).toBeUndefined();
  });

  it('老工程没有锁字段时按未锁读', () => {
    const legacy = roundTrip(doc({ layers: [layer()] }));
    delete (legacy.layers[0] as { lockPixel?: boolean }).lockPixel;
    delete (legacy.layers[0] as { lockPosition?: boolean }).lockPosition;
    const opened = projectPayloadToDocument(legacy, 'x.aurora').layers?.[0];
    expect(opened?.lockPixel).toBeUndefined();
    expect(opened?.lockPosition).toBeUndefined();
  });

  // ⚠️ 这组盯的是 2026-10-24 修的 IPC 键名契约：Rust `ProjectLayerRequest` 挂着
  // `rename_all = "camelCase"`，snake_case 的键会被静默丢弃——锁定/编组曾因此
  // 存盘即丢。这里把"存出去的键"钉死成 camelCase，谁改回 snake_case 当场红。
  it('载荷键名是 camelCase（Rust 侧 rename_all = camelCase，snake_case 会被静默丢掉）', () => {
    const payload = buildSavePayload(
      doc({
        layers: [layer({ lockPixel: true, groupId: 'g1', clipped: true, mask: mask() })],
      }),
    );
    const l = payload.layers[0] as unknown as Record<string, unknown>;
    for (const key of [
      'lockTransparent',
      'lockPixel',
      'lockPosition',
      'layerKind',
      'groupId',
      'maskSource',
      'maskBox',
      'maskDisabled',
      'clipped',
      'naturalWidth',
    ]) {
      expect(key in l, `缺少 camelCase 键 ${key}`).toBe(true);
    }
    for (const bad of [
      'lock_transparent',
      'lock_pixel',
      'lock_position',
      'layer_kind',
      'group_id',
      'mask_source',
      'mask_box',
      'mask_disabled',
    ]) {
      expect(bad in l, `不该出现 snake_case 键 ${bad}`).toBe(false);
    }
    expect(l.groupId).toBe('g1');
    expect(l.clipped).toBe(true);
  });

  it('蒙版往返：路径/自然尺寸/解链框/停用标志不丢；无蒙版 = null / 不落字段', () => {
    const unlinkedMask = mask({ box: box({ x: 3, w: 50 }), disabled: true });
    const masked = roundTrip(doc({ layers: [layer({ mask: unlinkedMask, clipped: true })] }));
    expect(masked.layers[0].maskSource).toBe('C:\\pics\\m.png');
    expect(masked.layers[0].maskBox).toEqual(box({ x: 3, w: 50 }));
    expect(masked.layers[0].maskDisabled).toBe(true);
    expect(masked.layers[0].clipped).toBe(true);
    const opened = projectPayloadToDocument(masked, 'x.aurora').layers?.[0];
    expect(opened?.mask).toEqual({
      source: 'C:\\pics\\m.png',
      naturalWidth: 64,
      naturalHeight: 32,
      box: box({ x: 3, w: 50 }),
      disabled: true,
    });
    expect(opened?.clipped).toBe(true);

    // 启用态：保存显式写 false，读回来折成 undefined（文档保持干净）
    const enabled = roundTrip(doc({ layers: [layer({ mask: mask() })] }));
    expect(enabled.layers[0].maskDisabled).toBe(false);
    expect(projectPayloadToDocument(enabled, 'x.aurora').layers?.[0]?.mask?.disabled).toBeUndefined();

    // 链接态：maskBox null → 文档里 mask.box 不落
    const linked = roundTrip(doc({ layers: [layer({ mask: mask() })] }));
    expect(linked.layers[0].maskBox).toBeNull();
    expect(projectPayloadToDocument(linked, 'x.aurora').layers?.[0]?.mask?.box).toBeUndefined();

    // 无蒙版：显式 null，读回 undefined
    const plain = buildSavePayload(doc({ layers: [layer()] }));
    expect(plain.layers[0].maskSource).toBeNull();
    expect(plain.layers[0].maskBox).toBeNull();
    expect(projectPayloadToDocument(roundTrip(doc()), 'x.aurora').layers?.[0].mask).toBeUndefined();
  });

  it('组行往返：无 source 也保留（组结构的锚点），成员的 groupId 不丢', () => {
    const groupDoc = doc({
      // 自底向上：成员在组行之前（createGroup 的数组口径）
      layers: [
        layer({ id: 'm1', groupId: 'g1', name: '成员' }),
        {
          ...layer({ id: 'g1', kind: 'group', name: '我的组', source: undefined }),
          source: undefined,
          naturalWidth: 0,
          naturalHeight: 0,
          box: box({ x: 0, y: 0, w: 0, h: 0 }),
        },
      ],
      activeLayerId: 'm1',
    });
    const opened = projectPayloadToDocument(roundTrip(groupDoc), 'x.aurora');
    expect(opened.layers?.map(l => l.id)).toEqual(['m1', 'g1']);
    expect(opened.layers?.[0].groupId).toBe('g1');
    expect(opened.layers?.[1].kind).toBe('group');
    expect(opened.layers?.[1].source).toBeUndefined();
    expect(opened.layers?.[1].naturalWidth).toBe(0);
  });

  it('字节格式化', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(52 * 1024 * 1024)).toBe('52.0 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
});
