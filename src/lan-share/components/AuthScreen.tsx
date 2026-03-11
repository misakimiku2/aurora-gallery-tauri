import React, { useState, useRef, useEffect } from 'react';

interface AuthScreenProps {
  onAuth: (code: string) => Promise<boolean>;
}

const AuthScreen: React.FC<AuthScreenProps> = ({ onAuth }) => {
  const [code, setCode] = useState(['', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleInput = (index: number, value: string) => {
    const digit = value.replace(/[^0-9]/g, '').slice(-1);
    const newCode = [...code];
    newCode[index] = digit;
    setCode(newCode);
    setError('');

    if (digit && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    const fullCode = newCode.join('');
    if (fullCode.length === 4) {
      handleAuth(fullCode);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === 'Enter') {
      handleAuth(code.join(''));
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const paste = e.clipboardData.getData('text');
    const digits = paste.replace(/[^0-9]/g, '').slice(0, 4).split('');
    const newCode = [...code];
    digits.forEach((d, i) => {
      if (i < 4) newCode[i] = d;
    });
    setCode(newCode);

    if (digits.length === 4) {
      handleAuth(digits.join(''));
    }
  };

  const handleAuth = async (fullCode: string) => {
    if (fullCode.length !== 4) {
      setError('请输入4位访问码');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const success = await onAuth(fullCode);
      if (!success) {
        setError('访问码错误');
        setCode(['', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch {
      setError('连接失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl p-8 shadow-xl max-w-md w-full border border-gray-200 dark:border-gray-700">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-500/10 mb-4">
            <svg className="w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Aurora Gallery</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm">局域网共享访问</p>
        </div>

        <div className="mb-6">
          <label className="block text-center text-gray-700 dark:text-gray-300 mb-4 text-sm font-medium">
            请输入访问码
          </label>
          
          <div className="flex justify-center gap-2 mb-4">
            {code.map((digit, index) => (
              <input
                key={index}
                ref={el => { inputRefs.current[index] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={e => handleInput(index, e.target.value)}
                onKeyDown={e => handleKeyDown(index, e)}
                onPaste={handlePaste}
                disabled={loading}
                className={`w-14 h-16 text-center text-2xl font-bold rounded-lg border-2 
                  ${error ? 'border-red-500' : 'border-gray-200 dark:border-gray-700 focus:border-blue-500'}
                  bg-white dark:bg-gray-900 text-gray-900 dark:text-white transition-colors duration-200
                  focus:outline-none focus:ring-2 focus:ring-blue-500/30
                  disabled:opacity-50`}
              />
            ))}
          </div>

          {error && (
            <p className="text-center text-red-500 text-sm mb-4">{error}</p>
          )}

          <button
            onClick={() => handleAuth(code.join(''))}
            disabled={loading || code.join('').length !== 4}
            className="w-full px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 
              text-white rounded-lg font-medium transition-colors duration-200
              disabled:cursor-not-allowed"
          >
            {loading ? '连接中...' : '连接'}
          </button>
        </div>

        <p className="text-center text-gray-500 dark:text-gray-400 text-sm">
          请从桌面应用获取访问码
        </p>
      </div>
    </div>
  );
};

export default AuthScreen;
