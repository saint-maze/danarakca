tailwind.config = {
  theme: {
    extend: {
      colors: {
        obsidian: '#101010',
        carbon: '#080808',
        chalk: '#f3f3f3',
        smoke: '#9c9c9c',
        ash: '#c1c1c1',
        graphite: '#212121',
        iron: '#474747',
        compass: '#6f6759',
        slatecard: '#3b3d45',
        pulse: '#98ff38',
        loss: '#ff7a6b',
        sukuk: '#8fb3d9',
        saham: '#d98f8f',
        rdpu: '#8fd9a8',
        emas: '#d9c38f',
        campuran: '#b38fd9'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace']
      },
      fontSize: {
        caption: ['13px', '1.5'],
        body: ['16px', '1.5'],
        'heading-xs': ['18px', '1.31'],
        subheading: ['21px', '1.3'],
        'heading-sm': ['23px', '1.07'],
        heading: ['34px', '1.03'],
        'heading-lg': ['44px', { lineHeight: '1.07', letterSpacing: '-0.31px' }],
        display: ['63px', { lineHeight: '1.05', letterSpacing: '-0.69px' }]
      },
      borderRadius: {
        tag: '4px',
        card: '8px'
      },
      maxWidth: {
        page: '1200px'
      }
    }
  }
};
