
import { FileNode, FileType, ImageMeta, UserProfile } from '../types';

const generateId = () => Math.random().toString(36).substr(2, 9);

const randomDate = (start: Date, end: Date) => {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString();
};

const randomHex = () => {
  return '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
};

const mockImages = [
  'https://picsum.photos/id/10/800/600',
  'https://picsum.photos/id/11/1600/900',
  'https://picsum.photos/id/12/1024/768',
  'https://picsum.photos/id/13/1200/1200',
  'https://picsum.photos/id/14/800/1200',
  'https://picsum.photos/id/15/1920/1080',
  'https://picsum.photos/id/16/600/600',
  'https://picsum.photos/id/17/900/1600',
  'https://picsum.photos/id/28/1000/1000',
  'https://picsum.photos/id/29/1200/800',
];

const formats = ['jpg', 'png', 'webp', 'gif', 'bmp', 'exr', 'hdr'];
const tagsPool = ['风景', '人物', '建筑', '设计', '素材', '灵感', '2024', '高清', '暗色', '亮色'];

const getTestSvgDataUrl = (type: 'greetings' | 'warning' | 'menu') => {
  let svg = '';
  if (type === 'greetings') {
    svg = `<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#f0f0f0"/>
  <text x="300" y="50" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="#333">AI Recognition Test</text>
  <rect x="50" y="100" width="240" height="100" fill="#fff" stroke="#ddd" rx="10"/>
  <text x="170" y="140" font-family="Arial, sans-serif" font-size="18" text-anchor="middle" fill="#555">English</text>
  <text x="170" y="170" font-family="Arial, sans-serif" font-size="28" text-anchor="middle" font-weight="bold" fill="#000">Hello World</text>
  <rect x="310" y="100" width="240" height="100" fill="#fff" stroke="#ddd" rx="10"/>
  <text x="430" y="140" font-family="SimHei, Arial, sans-serif" font-size="18" text-anchor="middle" fill="#555">中文 (Chinese)</text>
  <text x="430" y="170" font-family="SimHei, Arial, sans-serif" font-size="28" text-anchor="middle" font-weight="bold" fill="#000">你好，世界</text>
  <rect x="50" y="220" width="240" height="100" fill="#fff" stroke="#ddd" rx="10"/>
  <text x="170" y="260" font-family="Meiryo, Arial, sans-serif" font-size="18" text-anchor="middle" fill="#555">日本語 (Japanese)</text>
  <text x="170" y="290" font-family="Meiryo, Arial, sans-serif" font-size="24" text-anchor="middle" font-weight="bold" fill="#000">こんにちは、世界</text>
  <rect x="310" y="220" width="240" height="100" fill="#fff" stroke="#ddd" rx="10"/>
  <text x="430" y="260" font-family="Malgun Gothic, Arial, sans-serif" font-size="18" text-anchor="middle" fill="#555">한국어 (Korean)</text>
  <text x="430" y="290" font-family="Malgun Gothic, Arial, sans-serif" font-size="24" text-anchor="middle" font-weight="bold" fill="#000">안녕하세요, 세상</text>
</svg>`;
  } else if (type === 'warning') {
    svg = `<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#FFD700"/>
  <rect x="20" y="20" width="560" height="260" fill="none" stroke="black" stroke-width="10"/>
  <path d="M70,250 L130,130 L190,250 Z" fill="black"/>
  <rect x="125" y="180" width="10" height="40" fill="#FFD700"/>
  <circle cx="130" cy="235" r="5" fill="#FFD700"/>
  <text x="380" y="80" font-family="Arial, sans-serif" font-size="40" text-anchor="middle" font-weight="bold" fill="red">DANGER</text>
  <text x="380" y="115" font-family="Arial, sans-serif" font-size="20" text-anchor="middle" fill="black">High Voltage</text>
  <text x="380" y="160" font-family="SimHei, sans-serif" font-size="36" text-anchor="middle" font-weight="bold" fill="black">危险 - 高压电</text>
  <text x="380" y="205" font-family="Meiryo, sans-serif" font-size="30" text-anchor="middle" fill="black">危険 - 高電圧</text>
  <text x="380" y="250" font-family="Malgun Gothic, sans-serif" font-size="30" text-anchor="middle" fill="black">위험 - 고전압</text>
</svg>`;
  } else if (type === 'menu') {
    svg = `<svg width="500" height="600" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#fffaf0"/>
  <rect x="20" y="20" width="460" height="560" fill="none" stroke="#8B4513" stroke-width="4"/>
  <text x="250" y="70" font-family="serif" font-size="36" text-anchor="middle" font-weight="bold" fill="#8B4513">MENU / 菜单</text>
  <line x1="100" y1="90" x2="400" y2="90" stroke="#8B4513" stroke-width="2"/>
  <text x="50" y="150" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#333">1. Beef Noodle Soup</text>
  <text x="50" y="180" font-family="SimHei, sans-serif" font-size="20" fill="#666">CN: 红烧牛肉面</text>
  <text x="50" y="210" font-family="Meiryo, sans-serif" font-size="20" fill="#666">JP: 牛肉麺 (ニューロウメン)</text>
  <text x="50" y="240" font-family="Malgun Gothic, sans-serif" font-size="20" fill="#666">KR: 우육면</text>
  <text x="400" y="150" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#8B4513">$12.50</text>
  <line x1="50" y1="270" x2="450" y2="270" stroke="#ccc" stroke-dasharray="5,5"/>
  <text x="50" y="320" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#333">2. Fried Rice</text>
  <text x="50" y="350" font-family="SimHei, sans-serif" font-size="20" fill="#666">CN: 扬州炒饭</text>
  <text x="50" y="380" font-family="Meiryo, sans-serif" font-size="20" fill="#666">JP: チャーハン</text>
  <text x="50" y="410" font-family="Malgun Gothic, sans-serif" font-size="20" fill="#666">KR: 볶음밥</text>
  <text x="400" y="320" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#8B4513">$10.00</text>
  <line x1="50" y1="440" x2="450" y2="440" stroke="#ccc" stroke-dasharray="5,5"/>
  <text x="250" y="550" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#999">* Please inform us of any allergies</text>
</svg>`;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const getMockUserProfile = (): UserProfile => {
  return {
    name: 'Administrator',
    avatarUrl: 'https://ui-avatars.com/api/?name=Admin&background=0D8ABC&color=fff',
    ip: '127.0.0.1'
  };
};

export const createMockFile = (parentId: string, name: string, isFolder: boolean): FileNode => {
  const id = generateId();
  const isImage = !isFolder;
  const format = isImage ? formats[Math.floor(Math.random() * formats.length)] : '';
  
  const created = randomDate(new Date(2023, 0, 1), new Date());
  const modified = randomDate(new Date(2024, 0, 1), new Date());

  const sizeKb = 100 + Math.floor(Math.random() * 5000);
  const sizeBytes = sizeKb * 1024;

  const meta: ImageMeta | undefined = isImage ? {
    width: 800 + Math.floor(Math.random() * 1000),
    height: 600 + Math.floor(Math.random() * 1000),
    sizeKb: sizeKb,
    created: created,
    modified: modified,
    format: format,
    palette: Array.from({ length: 8 }, randomHex)
  } : undefined;

  const fileTags = isImage 
    ? Array.from({length: Math.floor(Math.random() * 3) + 1}, () => tagsPool[Math.floor(Math.random() * tagsPool.length)])
    : [];

  const uniqueTags = [...new Set(fileTags)];

  return {
    id,
    parentId,
    name: isFolder ? name : `${name}.${format}`,
    type: isFolder ? FileType.FOLDER : FileType.IMAGE,
    path: '',
    size: sizeBytes, // Added size for consistency
    children: isFolder ? [] : undefined,
    url: isImage ? mockImages[Math.floor(Math.random() * mockImages.length)] : undefined,
    previewUrl: isImage ? mockImages[Math.floor(Math.random() * mockImages.length)] : undefined,
    tags: uniqueTags,
    description: isImage ? '这是一张自动生成的测试图片' : undefined,
    meta,
    createdAt: created,
    updatedAt: modified
  };
};

export const initializeFileSystem = (): { roots: string[], files: Record<string, FileNode> } => {
  const files: Record<string, FileNode> = {};
  const roots: string[] = [];

  const root1 = createMockFile(null as any, '本地磁盘 (C:)', true);
  root1.path = 'C:/Photos';
  files[root1.id] = root1;
  roots.push(root1.id);

  // --- AI Text Recognition Test Images ---
  const aiTestFolder = createMockFile(root1.id, 'AI测试-多语言', true);
  files[aiTestFolder.id] = aiTestFolder;
  root1.children?.push(aiTestFolder.id);

  const greetingsSvg = createMockFile(aiTestFolder.id, 'Test_Greetings_Multilingual', false);
  greetingsSvg.url = getTestSvgDataUrl('greetings');
  greetingsSvg.previewUrl = greetingsSvg.url;
  greetingsSvg.meta = { ...greetingsSvg.meta!, format: 'svg', width: 600, height: 400, sizeKb: 15 };
  greetingsSvg.tags = ['测试', '多语言', 'AI', 'SVG'];
  files[greetingsSvg.id] = greetingsSvg;
  aiTestFolder.children?.push(greetingsSvg.id);

  const warningSvg = createMockFile(aiTestFolder.id, 'Test_Warning_Sign', false);
  warningSvg.url = getTestSvgDataUrl('warning');
  warningSvg.previewUrl = warningSvg.url;
  warningSvg.meta = { ...warningSvg.meta!, format: 'svg', width: 600, height: 300, sizeKb: 12 };
  warningSvg.tags = ['测试', '警告', 'AI', 'SVG'];
  files[warningSvg.id] = warningSvg;
  aiTestFolder.children?.push(warningSvg.id);

  const menuSvg = createMockFile(aiTestFolder.id, 'Test_Menu_Structure', false);
  menuSvg.url = getTestSvgDataUrl('menu');
  menuSvg.previewUrl = menuSvg.url;
  menuSvg.meta = { ...menuSvg.meta!, format: 'svg', width: 500, height: 600, sizeKb: 18 };
  menuSvg.tags = ['测试', '菜单', '排版', 'AI', 'SVG'];
  files[menuSvg.id] = menuSvg;
  aiTestFolder.children?.push(menuSvg.id);
  // -------------------------------------

  const sub1 = createMockFile(root1.id, '2024年旅行', true);
  files[sub1.id] = sub1;
  root1.children?.push(sub1.id);

  const sub2 = createMockFile(root1.id, '工作设计稿', true);
  files[sub2.id] = sub2;
  root1.children?.push(sub2.id);

  for (let i = 1; i <= 12; i++) {
    const img = createMockFile(sub1.id, `IMG_00${i}`, false);
    files[img.id] = img;
    sub1.children?.push(img.id);
  }

  const sub2_1 = createMockFile(sub2.id, 'Logo方案', true);
  files[sub2_1.id] = sub2_1;
  sub2.children?.push(sub2_1.id);

  for (let i = 1; i <= 6; i++) {
    const img = createMockFile(sub2.id, `Design_v${i}`, false);
    files[img.id] = img;
    sub2.children?.push(img.id);
  }

  const gifFile = createMockFile(sub2.id, 'Anim_Logo_Final', false);
  gifFile.meta!.format = 'gif';
  gifFile.url = 'https://media.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.gif';
  gifFile.previewUrl = 'https://picsum.photos/id/237/400/300';
  files[gifFile.id] = gifFile;
  sub2.children?.push(gifFile.id);

  const webpFile = createMockFile(sub2.id, 'Banner_Interactive', false);
  webpFile.meta!.format = 'webp';
  webpFile.url = 'https://mathiasbynens.be/demo/animated-webp-supported.webp';
  webpFile.previewUrl = 'https://picsum.photos/id/238/400/300';
  files[webpFile.id] = webpFile;
  sub2.children?.push(webpFile.id);

  for (let i = 1; i <= 4; i++) {
    const img = createMockFile(sub2_1.id, `Logo_Variation_${i}`, false);
    files[img.id] = img;
    sub2_1.children?.push(img.id);
  }

  const rootFace = createMockFile(root1.id, 'AI测试-人像', true);
  files[rootFace.id] = rootFace;
  root1.children?.push(rootFace.id);

  const faceUrls = [
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800',
      'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=800',
  ];

  faceUrls.forEach((url, i) => {
      const img = createMockFile(rootFace.id, `Portrait_00${i+1}`, false);
      img.url = url;
      img.tags = ['测试', '待分析'];
      files[img.id] = img;
      rootFace.children?.push(img.id);
  });

  // --- 大量测试文件 (200个虚拟文件在一个文件夹内) ---
  const largeTestFolder = createMockFile(root1.id, '测试数据集-200文件', true);
  files[largeTestFolder.id] = largeTestFolder;
  root1.children?.push(largeTestFolder.id);

  // 在一个文件夹内生成200个文件
  for (let i = 1; i <= 200; i++) {
    const isImage = Math.random() > 0.1; // 90% 是图片
    const fileBaseName = isImage ? `IMG_${String(i).padStart(4, '0')}` : `DOC_${String(i).padStart(4, '0')}`;
    
    const file = createMockFile(largeTestFolder.id, fileBaseName, !isImage);
    
    if (isImage) {
      // 为图片文件添加更多随机性
      const randomImgIndex = Math.floor(Math.random() * mockImages.length);
      file.url = mockImages[randomImgIndex];
      file.previewUrl = mockImages[randomImgIndex];
      file.tags = [
        tagsPool[Math.floor(Math.random() * tagsPool.length)],
        tagsPool[Math.floor(Math.random() * tagsPool.length)],
        `编号${i}`
      ];
      file.description = `测试图片 ${i}`;
    } else {
      // 为文档文件添加特殊标记
      file.tags = ['文档', '测试数据', `编号${i}`];
      file.description = `测试文档 ${i}`;
    }
    
    files[file.id] = file;
    largeTestFolder.children?.push(file.id);
  }
  // --- 大量测试文件结束 ---

  return { roots, files };
};

export const formatSize = (kb: number | undefined | null) => {
  if (kb === undefined || kb === null) return '---';
  if (kb > 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
  if (kb > 1024) return `${(kb / 1024).toFixed(2)} MB`;
  return `${kb} KB`;
};

export const getFolderPreviewImages = (files: Record<string, FileNode>, folderId: string, limit: number = 3): string[] => {
  const folder = files[folderId];
  if (!folder || !folder.children || folder.children.length === 0) return [];

  const found: string[] = [];
  const queue = [...folder.children];
  let head = 0;
  let iterations = 0;
  const maxIterations = 100;

  while (head < queue.length && found.length < limit && iterations < maxIterations) {
    const id = queue[head++];
    iterations++;
    
    const node = files[id];
    if (!node) continue;

    // Note: In Tauri, file.url is a file path, not a usable URL
    // Only use URLs that are valid (data: or http/https)
    if (node.type === FileType.IMAGE && node.url && (node.url.startsWith('data:') || node.url.startsWith('http'))) {
      found.push(node.previewUrl || node.url);
    } else if (node.type === FileType.FOLDER && node.children) {
       for (const childId of node.children) {
           queue.push(childId);
       }
    }
  }
  return found;
};

export const getFolderStats = (files: Record<string, FileNode>, folderId: string) => {
  let size = 0;
  let fileCount = 0;
  let dirCount = 0;

  const stack = [folderId];
  let head = 0;
  
  while(head < stack.length) {
      const id = stack[head++];
      const node = files[id];
      if (!node) continue;
      
      if (node.type === FileType.IMAGE) {
          fileCount++;
          size += node.meta?.sizeKb || 0;
      } else if (node.type === FileType.FOLDER) {
          if (id !== folderId) dirCount++; 
          if (node.children) {
             for(const childId of node.children) {
                 stack.push(childId);
             }
          }
      }
  }

  return { size, fileCount, dirCount };
};
