import React, { useCallback, useMemo } from 'react';
import { Wifi, WifiOff, Loader2, ChevronDown, ChevronRight, Folder, Smartphone, SortAsc, SortDesc, Clock } from 'lucide-react';
import { isAndroidPlatformCached } from '../../api/tauri-bridge';
import { LAN_ROOT_IMAGES_ID, ANDROID_ROOT_IMAGES_ID } from '../../constants';
import { FileNode, FileType } from '../../types';
import MarqueeText from '../MarqueeText';
import { AndroidDeviceInfo } from '../android-client/androidClientTypes';

interface NetworkSectionProps {
  onNavigateHome: () => void;
  onToggleExpand: () => void;
  onNavigateFolder: (folderId: string) => void;
  onOpenSettings: () => void;
  expanded: boolean;
  connected: boolean;
  loading?: boolean;
  isSelected?: boolean;
  lanRoots: string[];
  files: Record<string, FileNode>;
  currentFolderId?: string;
  listHeight?: number;
  t: (key: string) => string;
  // 安卓设备节点（桌面端连接安卓端，多设备）
  androidDevices?: AndroidDeviceInfo[];
  androidActiveKey?: string;
  expandedAndroidKey?: string | null;
  onToggleAndroidDevice?: (key: string) => void;
  onNavigateAndroidHome?: (key: string) => void;
  onNavigateAndroidFolder?: (folderId: string) => void;
  onOpenAndroidSettings?: () => void;
  // 排序（与树状文件夹栏同一套状态：名称 / 修改时间 × 升 / 降）
  sortMode?: 'name' | 'date';
  sortOrder?: 'asc' | 'desc';
  onToggleSort?: () => void;
}

/**
 * 排序用的时间戳：本地文件夹在 meta.modified，远程（安卓 / LAN）文件夹
 * 没有 meta，时间落在 createdAt / updatedAt 上。
 */
const nodeSortTime = (node: FileNode): number => {
  const modified = Number((node.meta as any)?.modified);
  if (modified) return modified;
  const parsed = Date.parse(node.updatedAt || node.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 扁平列表去重标注：网络栏展示的是"所有含图文件夹"的扁平列表（没有树状层级），
 * 不同主文件夹下的同名子文件夹会撞名（如 A/1 与 B/1 都叫 "1"）。
 * 对重名的项显示「主文件夹/末级文件夹」，层级更深时中间用省略号带过：
 *   A/1、B/1、A/.../1。名称唯一的保持原样，列表依旧干净。
 * 返回 id -> { dir: 前缀（可为空）, name: 末级名称, full: 完整相对路径 }。
 */
const buildDisambiguatedLabels = (
  nodes: FileNode[]
): Map<string, { dir: string; name: string; full: string }> => {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = (n.name || '').toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const labels = new Map<string, { dir: string; name: string; full: string }>();
  for (const n of nodes) {
    if ((counts.get((n.name || '').toLowerCase()) || 0) <= 1) continue;
    // 虚拟"根目录图片"不是真实路径，不参与路径标注
    if (n.id === LAN_ROOT_IMAGES_ID || n.id.startsWith(`${ANDROID_ROOT_IMAGES_ID}:`)) continue;
    const rel = (n.remotePath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      // 兜底：旧版服务端可能下发 Windows 绝对路径，去掉盘符段（E:/...）
      .replace(/^[a-zA-Z]:\//, '');
    if (!rel) continue;
    const segs = rel.split('/');
    if (segs.length <= 1) continue; // 顶层文件夹名称本身不会重复
    const dir = segs.length === 2 ? segs[0] : `${segs[0]}/...`;
    labels.set(n.id, { dir, name: segs[segs.length - 1], full: rel });
  }
  return labels;
};

/**
 * 网络分区：
 * - 安卓端：桌面端服务节点（LAN 客户端，现有功能）
 * - 桌面端：安卓设备节点列表（桌面端连接安卓端，多设备支持）
 */
const NetworkSection: React.FC<NetworkSectionProps> = React.memo(
  ({
    onNavigateHome,
    onToggleExpand,
    onNavigateFolder,
    onOpenSettings,
    expanded,
    connected,
    loading = false,
    isSelected = false,
    lanRoots,
    files,
    currentFolderId,
    listHeight,
    t,
    androidDevices = [],
    androidActiveKey = '',
    expandedAndroidKey = null,
    onToggleAndroidDevice,
    onNavigateAndroidHome,
    onNavigateAndroidFolder,
    onOpenAndroidSettings,
    sortMode = 'name',
    sortOrder = 'asc',
    onToggleSort,
  }) => {
    const isAndroid = isAndroidPlatformCached();
    const iconSize = isAndroid ? 18 : 14;
    const sortIconSize = isAndroid ? 18 : 14;
    const sortPad = isAndroid ? 'p-1.5' : 'p-1';
    const textClass = isAndroid ? 'text-sm' : 'text-xs';
    const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
    const chevronMr = isAndroid ? 'mr-1.5' : 'mr-1';

    /** 按当前排序设置比较两个文件夹节点（时间相同时回退到名称，保证顺序稳定）。 */
    const compareNodes = useCallback((a: FileNode, b: FileNode): number => {
      if (sortMode === 'date') {
        const diff = nodeSortTime(a) - nodeSortTime(b);
        if (diff !== 0) return sortOrder === 'asc' ? diff : -diff;
      }
      const res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      return sortOrder === 'asc' ? res : -res;
    }, [sortMode, sortOrder]);

    /** 设备是否可正常浏览（已连接且已加载到顶层文件夹）。 */
    const isDeviceBrowsable = (device: AndroidDeviceInfo): boolean =>
      !!device.connected && (device.roots?.length ?? 0) > 0;

    // 设备行排序：多设备时按名称（时间模式取该设备最新文件夹的时间）
    const sortedAndroidDevices = useMemo(() => {
      const list = [...androidDevices];
      list.sort((a, b) => {
        if (sortMode === 'date') {
          const timeOf = (d: AndroidDeviceInfo) =>
            (d.roots || []).reduce((max, id) => {
              const node = files[id];
              return node ? Math.max(max, nodeSortTime(node)) : max;
            }, 0);
          const diff = timeOf(a) - timeOf(b);
          if (diff !== 0) return sortOrder === 'asc' ? diff : -diff;
        }
        const res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        return sortOrder === 'asc' ? res : -res;
      });
      return list;
    }, [androidDevices, files, sortMode, sortOrder]);

    const getSortTitle = () =>
      sortMode === 'name'
        ? sortOrder === 'asc'
          ? 'A-Z'
          : 'Z-A'
        : sortOrder === 'desc'
          ? t('sort.newest')
          : t('sort.oldest');

    const title = t('sidebar.network.title') || '网络';
    const disconnectedHint = t('sidebar.network.disconnected') || '未连接';
    const loadingHint = t('sidebar.network.loading') || '加载中...';
    const noFoldersHint = t('sidebar.noFolders') || '暂无文件夹';
    const mobileDevicesTitle = t('sidebar.network.androidDevice') || '移动设备';
    const androidHint = t('sidebar.network.androidDisconnected') || '未连接';
    const rowHeight = isAndroid ? '35px' : '30px';

    const rootNodes = useMemo(() => {
      return (lanRoots || [])
        .map((id) => files[id])
        .filter((f): f is FileNode => !!f && f.type === FileType.FOLDER)
        .sort(compareNodes);
    }, [lanRoots, files, compareNodes]);

    // 同名文件夹的区分标注（详见 buildDisambiguatedLabels）
    const rootLabels = useMemo(() => buildDisambiguatedLabels(rootNodes), [rootNodes]);

    const handleHeaderClick = (e: React.MouseEvent) => {
      if (loading) return;
      if ((e.target as HTMLElement).closest('.expand-icon')) {
        e.stopPropagation();
        onToggleExpand();
      } else if (connected) {
        onNavigateHome();
      } else {
        onOpenSettings();
      }
    };

    // 展开列表的可用高度：由侧边栏（TreeSidebar）按各分区固定部分实测后传入，
    // 保证展开后不超出视口、不挤压/覆盖下方栏目（与 FolderSection 同思路）
    const availableHeight = Math.max(120, listHeight || 300);

    return (
      <div
        data-sidebar-section="network"
        className={`select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 flex-none`}
      >
        {/* ===== 桌面端：移动设备节点（无设备=灰色"移动设备"未连接；有设备=直接显示设备名） ===== */}
        {!isAndroid && (
          <div className="flex flex-col">
            {androidDevices.length === 0 ? (
              <div
                className="flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative mt-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg"
                style={{
                  height: '40px',
                  minHeight: '40px',
                  flexShrink: 0,
                  margin: '0 10px',
                }}
                onClick={() => onOpenAndroidSettings?.()}
              >
                <div className={`p-1 ${chevronMr} rounded opacity-40`}>
                  <ChevronRight size={iconSize} />
                </div>
                <Smartphone size={iconSize} className={`${iconMr} text-gray-400 dark:text-gray-500`} />
                <span className="font-bold text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500 truncate flex-1">
                  {mobileDevicesTitle}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                  {androidHint}
                </span>
              </div>
            ) : (
              sortedAndroidDevices.map((device) => {
                const isActive = androidActiveKey === device.key;
                const isDeviceExpanded = expandedAndroidKey === device.key;
                const deviceRootNodes = (device.roots || [])
                  .map((id) => files[id])
                  .filter((f): f is FileNode => !!f && f.type === FileType.FOLDER)
                  .sort(compareNodes);
                // 设备行与展开的文件夹列表以 Fragment 平铺为分区根节点的直接
                // flex 子项：列表容器 min-h-0 + overflow-y-auto，任何剩余空间
                // 压缩都由列表自身吸收（内部滚动），不会溢出覆盖下方栏目。
                return (
                  <React.Fragment key={device.key}>
                    <div
                      className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative mt-1 ${
                        isActive
                          ? 'bg-blue-600 text-white rounded-lg'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg'
                      }`}
                      style={{
                        height: '40px',
                        minHeight: '40px',
                        flexShrink: 0,
                        margin: '0 10px',
                      }}
                      title={
                        device.lastError
                          ? `${device.name} · ${device.lastError}`
                          : device.connected
                            ? device.name
                            : `${device.name} · ${androidHint}`
                      }
                      onClick={() => onNavigateAndroidHome?.(device.key)}
                    >
                      <div
                        className={`expand-icon p-1 ${chevronMr} rounded ${
                          isActive ? 'text-white' : 'text-gray-400'
                        } hover:bg-black/10 dark:hover:bg-white/10`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleAndroidDevice?.(device.key);
                        }}
                      >
                        {isDeviceExpanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
                      </div>
                      <div className="flex items-center flex-1 min-w-0">
                        {device.loading ? (
                          <Loader2
                            size={iconSize}
                            className={`${iconMr} ${isActive ? 'text-white' : 'text-blue-500 dark:text-blue-400'} animate-spin`}
                          />
                        ) : (
                          <Smartphone
                            size={iconSize}
                            className={`${iconMr} shrink-0 ${isActive ? 'text-white' : device.connected ? 'text-green-500 dark:text-green-400' : 'text-gray-400'}`}
                          />
                        )}
                        <span
                          className={`font-bold ${textClass} truncate flex-1 ${
                            isActive
                              ? 'text-white'
                              : 'text-gray-600 dark:text-gray-300 group-hover:text-black dark:group-hover:text-white'
                          }`}
                        >
                          {device.name}
                        </span>
                        {/* 未连通时给出明确状态：重连中 / 未连接（点击即重试） */}
                        {!device.connected && (
                          <span
                            className={`text-[10px] shrink-0 ml-1.5 ${
                              isActive ? 'text-white/80' : 'text-gray-400 dark:text-gray-500'
                            }`}
                          >
                            {device.loading ? loadingHint : androidHint}
                          </span>
                        )}
                      </div>
                      {/* 排序按钮：仅在该设备已连接且能正常浏览时显示 */}
                      {onToggleSort && isDeviceBrowsable(device) && (
                        <div
                          data-android-sort-toggle
                          className={`${sortPad} flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${isActive ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-blue-500'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleSort();
                          }}
                          title={getSortTitle()}
                        >
                          {sortMode === 'name' ? (
                            sortOrder === 'asc' ? <SortAsc size={sortIconSize} /> : <SortDesc size={sortIconSize} />
                          ) : (
                            <Clock size={sortIconSize} className={sortOrder === 'asc' ? 'rotate-180' : ''} />
                          )}
                        </div>
                      )}
                    </div>
                    {isDeviceExpanded && (
                      <div
                        data-sidebar-list
                        className="overflow-y-auto auto-hide-scrollbar min-h-0"
                        style={{
                          maxHeight: `${availableHeight}px`,
                          contain: 'layout paint style',
                        }}
                      >
                        {deviceRootNodes.length === 0 ? (
                          <div className="px-10 py-2 text-xs text-gray-400 italic">
                            {device.loading ? loadingHint : noFoldersHint}
                          </div>
                        ) : (
                          deviceRootNodes.map((node) => {
                            const isCurrent = node.id === currentFolderId;
                            return (
                              <div
                                key={node.id}
                                className={`flex items-center cursor-pointer transition-colors border border-transparent ${
                                  isCurrent
                                    ? 'bg-blue-600 text-white rounded-lg'
                                    : 'hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg'
                                }`}
                                style={{ paddingLeft: '20px', height: rowHeight, margin: '0 12px' }}
                                onClick={() => onNavigateAndroidFolder?.(node.id)}
                              >
                                <Folder
                                  size={16}
                                  className={`mr-2 shrink-0 ${isCurrent ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`}
                                />
                                <MarqueeText className="flex-1 pointer-events-none" active={isCurrent}>{node.name}</MarqueeText>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </div>
        )}

        {/* ===== 安卓端：桌面端服务（LAN 客户端）节点 ===== */}
        {isAndroid && (
          <div
            className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative mt-1 ${
              isSelected
                ? 'text-white rounded-lg'
                : 'hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg'
            }`}
            style={{
              height: isAndroid ? '55px' : '40px',
              minHeight: isAndroid ? '55px' : '40px',
              flexShrink: 0,
              margin: '0 10px',
              ...(isSelected ? { backgroundColor: '#3b82f6' } : {}),
            }}
            onClick={handleHeaderClick}
          >
            <div className={`expand-icon p-1 ${chevronMr} hover:bg-black/10 dark:hover:bg-white/10 rounded`}>
              {expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
            </div>
            <div className="flex items-center flex-1 min-w-0">
              {loading ? (
                <Loader2
                  size={iconSize}
                  className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'} animate-spin`}
                />
              ) : connected ? (
                <Wifi
                  size={iconSize}
                  className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`}
                />
              ) : (
                <WifiOff
                  size={iconSize}
                  className={`${iconMr} text-gray-400 dark:text-gray-500`}
                />
              )}
              <span
                className={`font-bold ${textClass} uppercase tracking-wider transition-colors truncate ${
                  isSelected
                    ? 'text-white'
                    : connected
                    ? 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'
                    : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {title}
              </span>
            </div>
            {loading ? (
              <span className={`text-xs shrink-0 ${isSelected ? 'text-white/80' : 'text-blue-500 dark:text-blue-400'}`}>
                {loadingHint}
              </span>
            ) : !connected ? (
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                {disconnectedHint}
              </span>
            ) : null}
            {/* 排序按钮：仅在已连接且能正常浏览桌面端文件夹时显示 */}
            {onToggleSort && connected && !loading && rootNodes.length > 0 && (
              <div
                data-lan-sort-toggle
                className={`${sortPad} flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${isSelected ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-blue-500'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSort();
                }}
                title={getSortTitle()}
              >
                {sortMode === 'name' ? (
                  sortOrder === 'asc' ? <SortAsc size={sortIconSize} /> : <SortDesc size={sortIconSize} />
                ) : (
                  <Clock size={sortIconSize} className={sortOrder === 'asc' ? 'rotate-180' : ''} />
                )}
              </div>
            )}
          </div>
        )}

        {isAndroid && expanded && (
          <div
            data-sidebar-list
            className={`py-1 min-h-0 overflow-y-auto ${isAndroid ? 'no-scrollbar' : 'scrollbar-thin'}`}
            style={{
              maxHeight: `${availableHeight}px`,
            }}
          >
            {connected && (
              <>
                {rootNodes.length === 0 ? (
                  <div className="px-10 py-4 text-xs text-gray-400 italic">
                    {loading ? loadingHint : noFoldersHint}
                  </div>
                ) : (
                  rootNodes.map((node) => {
                    const isCurrent = node.id === currentFolderId;
                    // 同名文件夹显示父级路径前缀（如 A/1、B/1），唯一名保持简洁
                    const label = rootLabels.get(node.id);
                    return (
                      <div
                        key={node.id}
                        className={`flex items-center px-2 cursor-pointer transition-colors border border-transparent ${
                          isCurrent
                            ? 'bg-blue-600 text-white rounded-lg'
                            : 'hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg'
                        }`}
                        style={{ paddingLeft: '20px', ...(isAndroid ? { height: '35px' } : {}), margin: '0 10px' }}
                        onClick={() => onNavigateFolder(node.id)}
                        title={label ? label.full : node.name}
                      >
                        <div className="w-[14px] mr-1" />
                        <Folder
                          size={16}
                          className={`mr-2 shrink-0 ${isCurrent ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`}
                        />
                        <MarqueeText className="flex-1 pointer-events-none" active={isCurrent}>
                          {label ? (
                            <>
                              {label.dir && <span className="opacity-60">{label.dir}/</span>}
                              {label.name}
                            </>
                          ) : (
                            node.name
                          )}
                        </MarqueeText>
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

export default NetworkSection;
