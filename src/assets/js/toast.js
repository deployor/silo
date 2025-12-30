/**
 * Toast Notification System
 * Displays non-blocking notifications in the bottom-right corner.
 */

function showToast(message, type = 'info', duration = 3000) {
    // Ensure container exists
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none';
        document.body.appendChild(container);
    }

    // Create toast element
    const toast = document.createElement('div');
    
    // Base styles
    let classes = 'pointer-events-auto min-w-[300px] max-w-md p-4 rounded-xl shadow-lg border flex items-start gap-3 transform transition-all duration-300 translate-x-full opacity-0';
    
    // Type-specific styles
    if (type === 'success') {
        classes += ' bg-hc-dark border-emerald-500/30 text-white';
    } else if (type === 'error') {
        classes += ' bg-hc-dark border-hc-red/30 text-white';
    } else {
        classes += ' bg-hc-dark border-white/10 text-white';
    }
    
    toast.className = classes;

    // Icon
    let icon = '';
    if (type === 'success') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
        </svg>`;
    } else if (type === 'error') {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-hc-red shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
        </svg>`;
    } else {
        icon = `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-hc-blue shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
        </svg>`;
    }

    toast.innerHTML = `
        ${icon}
        <div class="flex-1 text-sm font-medium break-words">${message}</div>
        <button onclick="this.parentElement.remove()" class="text-text-muted hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
        </button>
    `;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.remove('translate-x-full', 'opacity-0');
    });

    // Auto dismiss
    setTimeout(() => {
        toast.classList.add('translate-x-full', 'opacity-0');
        setTimeout(() => {
            if (toast.parentElement) {
                toast.remove();
            }
        }, 300); // Wait for transition
    }, duration);
}
