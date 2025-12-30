# Toast Notification Implementation Plan

## Objective
Replace native browser `alert()` dialogs with a modern, non-blocking "toast" notification system to improve user experience.

## Components

### 1. Toast Logic (`src/assets/js/toast.js`)
A new JavaScript file containing the `showToast` function.
- **Function Signature:** `showToast(message, type = 'info', duration = 3000)`
- **Types:** `success`, `error`, `info`
- **Behavior:**
  - Creates a fixed container (`#toast-container`) in the bottom-right corner if it doesn't exist.
  - Appends a new toast element with Tailwind CSS styling.
  - Auto-dismisses after `duration`.
  - Supports manual dismissal (click to close).

### 2. Styling (`src/styles.css`)
Add any necessary custom animations or overrides. Most styling will be handled via Tailwind utility classes injected by the JS.
- **Animations:** Slide-in from right, Fade-out.

### 3. Integration (`src/views/layouts/main.hbs`)
Include the new script in the global layout so it's available on all pages.
- Add `<script src="/assets/js/toast.js"></script>` before `</body>`.

### 4. Refactoring
Replace all instances of `alert()` in the following files:
- `src/views/dashboard.hbs`
- `src/views/files.hbs`
- `src/views/admin.hbs`

## Implementation Steps

1.  **Create Directory:** Ensure `src/assets/js` exists.
2.  **Create Script:** Write `src/assets/js/toast.js`.
3.  **Update Layout:** Edit `src/views/layouts/main.hbs`.
4.  **Update Styles:** Add animations to `src/styles.css`.
5.  **Refactor Code:** Search and replace `alert()` calls.

## Example Usage
```javascript
// Error
showToast("Failed to delete bucket", "error");

// Success
showToast("Bucket created successfully", "success");
```
