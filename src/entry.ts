// The real app and the unchanged presentation have separate module trees/styles.
if (location.pathname === "/publish" || location.pathname === "/inbox") {
  void import("./live/App.tsx");
} else {
  void import("./main.tsx");
}
