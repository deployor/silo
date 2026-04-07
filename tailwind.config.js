/** @type {import('tailwindcss').Config} */
export default {
	content: ["./src/**/*.{js,ts,jsx,tsx,hbs,html}"],
	theme: {
		extend: {
			colors: {
				"hc-red": "#ec3750",
				"hc-dark": "#17171d",
				"hc-darker": "#131316",
				"hc-blue": "#ec3750",
				"sidebar-bg": "#1c1c21",
				"text-main": "#e0e6ed",
				"text-muted": "#94a3b8",
			},
			fontFamily: {
				sans: ['"JetBrains Mono"', "monospace"],
				mono: ['"JetBrains Mono"', "monospace"],
			},
		},
	},
	plugins: [],
};
