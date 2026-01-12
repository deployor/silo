import Alpine from "alpinejs";

/**
 * Entry point for `/onboarding` only.
 *
 * NOTE:
 * - This is intentionally minimal.
 * - Any onboarding-specific Alpine components can be registered here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).Alpine = Alpine;

Alpine.data("onboarding", () => {
	return {
		step: 1,

		init() {
			this.step = 1;
		},

		next() {
			this.step = Math.min(this.step + 1, 4);
		},

		prev() {
			this.step = Math.max(this.step - 1, 1);
		},
	};
});

Alpine.start();
