import colors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gray: {
          ...colors.neutral,
          750: '#333333',
          850: '#1e1e1e',
          950: '#0a0a0a',
        }
      },
      cursor: {
        'zoom-in': 'zoom-in',
        'grab': 'grab',
        'grabbing': 'grabbing',
      },
      animation: {
        'zoom-in': 'zoomIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-left': 'slideLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-right': 'slideRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fade-in': 'fadeIn 0.5s ease-in-out forwards',
        'toast-up': 'toastUp 0.3s ease-out forwards',
        'countdown': 'countdown 5s linear forwards',
        'ken-burns': 'kenBurns 20s ease-out infinite alternate',
        // 幻灯片过渡动画 - 使用 both 确保动画开始前就应用初始状态
        'slideshow-fade-in': 'slideshowFadeIn 0.6s ease-in-out both',
        'slideshow-fade-out': 'slideshowFadeOut 0.6s ease-in-out both',
        'slideshow-slide-in': 'slideshowSlideIn 0.6s ease-in-out both',
        'slideshow-slide-out': 'slideshowSlideOut 0.6s ease-in-out both',
      },
      keyframes: {
        zoomIn: {
          '0%': { opacity: '0', transform: 'scale(0.9)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideLeft: {
          '0%': { opacity: '0', transform: 'translateX(50px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(-50px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        toastUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        countdown: {
          '0%': { width: '100%' },
          '100%': { width: '0%' },
        },
        kenBurns: {
          '0%': { transform: 'scale(1)' },
          '100%': { transform: 'scale(1.15)' },
        },
        // 幻灯片淡入淡出
        slideshowFadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideshowFadeOut: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        // 幻灯片滑动
        slideshowSlideIn: {
          '0%': { opacity: '0', transform: 'translateX(100%)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideshowSlideOut: {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(-100%)' },
        },
      }
    }
  },
  plugins: [],
}