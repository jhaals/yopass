(function () {
  try {
    var DEFAULT_LIGHT = 'emerald';
    var DEFAULT_DARK = 'dim';
    var storedMode = localStorage.getItem('themeMode'); // 'light' | 'dark'
    var prefersDark =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    var mode =
      storedMode === 'light' || storedMode === 'dark'
        ? storedMode
        : prefersDark
          ? 'dark'
          : 'light';
    document.documentElement.setAttribute(
      'data-theme',
      mode === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT,
    );
  } catch (e) {}
})();
