export const getPinyinGroup = (char: string) => {
    if (!char) return '#';
    const c = char.charAt(0);
    if (/^[a-zA-Z]/.test(c)) return c.toUpperCase();
    if (/^[0-9]/.test(c)) return c;
    if (/[\u4e00-\u9fa5]/.test(c)) {
        try {
            const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'accent' });
            const boundaries = [
                { char: '阿', group: 'A' },
                { char: '芭', group: 'B' },
                { char: '擦', group: 'C' },
                { char: '搭', group: 'D' },
                { char: '蛾', group: 'E' },
                { char: '发', group: 'F' },
                { char: '噶', group: 'G' },
                { char: '哈', group: 'H' },
                { char: '击', group: 'J' },
                { char: '喀', group: 'K' },
                { char: '垃', group: 'L' },
                { char: '妈', group: 'M' },
                { char: '拿', group: 'N' },
                { char: '哦', group: 'O' },
                { char: '啪', group: 'P' },
                { char: '期', group: 'Q' },
                { char: '然', group: 'R' },
                { char: '撒', group: 'S' },
                { char: '塌', group: 'T' },
                { char: '挖', group: 'W' },
                { char: '昔', group: 'X' },
                { char: '压', group: 'Y' },
                { char: '匝', group: 'Z' }
            ];
            for (let i = boundaries.length - 1; i >= 0; i--) {
                if (collator.compare(c, boundaries[i].char) >= 0) return boundaries[i].group;
            }
        } catch (e) {
            console.warn('Native pinyin grouping failed', e);
        }
    }
    return '#';
};
