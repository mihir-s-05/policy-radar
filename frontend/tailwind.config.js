/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                border: "hsl(var(--border))",
                input: "hsl(var(--input))",
                ring: "hsl(var(--ring))",
                background: "hsl(var(--background))",
                foreground: "hsl(var(--foreground))",
                primary: {
                    DEFAULT: "hsl(var(--primary))",
                    foreground: "hsl(var(--primary-foreground))",
                },
                secondary: {
                    DEFAULT: "hsl(var(--secondary))",
                    foreground: "hsl(var(--secondary-foreground))",
                },
                destructive: {
                    DEFAULT: "hsl(var(--destructive))",
                    foreground: "hsl(var(--destructive-foreground))",
                },
                muted: {
                    DEFAULT: "hsl(var(--muted))",
                    foreground: "hsl(var(--muted-foreground))",
                },
                accent: {
                    DEFAULT: "hsl(var(--accent))",
                    foreground: "hsl(var(--accent-foreground))",
                },
                popover: {
                    DEFAULT: "hsl(var(--popover))",
                    foreground: "hsl(var(--popover-foreground))",
                },
                card: {
                    DEFAULT: "hsl(var(--card))",
                    foreground: "hsl(var(--card-foreground))",
                },
                parchment: {
                    50: "#fdfbf7",
                    100: "#f9f3e8",
                    200: "#f4e4bc",
                    300: "#e8d4a8",
                    400: "#d4bc8a",
                    500: "#c4a870",
                    600: "#a88a50",
                    700: "#8b6d3a",
                    800: "#5c4033",
                    900: "#3d2b1f",
                },
                sepia: {
                    ink: "#3d2b1f",
                    brown: "#5c4033",
                    light: "#8b6d3a",
                    accent: "#a88a50",
                },
                leather: {
                    dark: "#2c1810",
                    DEFAULT: "#3d2b1f",
                    light: "#5c4033",
                },
            },
            fontFamily: {
                manuscript: ["'IM Fell English'", "Georgia", "serif"],
                "manuscript-sc": ["'IM Fell English SC'", "Georgia", "serif"],
                display: ["'Playfair Display'", "Georgia", "serif"],
                body: ["'Spectral'", "Georgia", "serif"],
            },
            borderRadius: {
                lg: `var(--radius)`,
                md: `calc(var(--radius) - 2px)`,
                sm: "calc(var(--radius) - 4px)",
            },
            boxShadow: {
                'parchment': '0 8px 32px rgba(60, 40, 20, 0.25), 0 2px 8px rgba(60, 40, 20, 0.15), inset 0 0 40px rgba(139, 90, 43, 0.05)',
                'leather': '0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
                'wax': 'inset 0 2px 4px rgba(255, 255, 255, 0.2), inset 0 -2px 4px rgba(0, 0, 0, 0.3), 0 3px 8px rgba(0, 0, 0, 0.3)',
                'document': '0 10px 40px rgba(60, 40, 20, 0.3), 0 4px 12px rgba(60, 40, 20, 0.2)',
            },
        },
    },
    plugins: [],
}
