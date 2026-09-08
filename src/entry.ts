declare const __APP_PROFILE__: "local" | "sepolia";
// The real app and the unchanged presentation have separate module trees/styles.
if (location.pathname === "/deploy" && __APP_PROFILE__ === "sepolia") {
  void import("./live/Deploy.tsx");
} else if (location.pathname === "/publish" || location.pathname === "/inbox") {
  void import("./live/App.tsx");
} else {
  void import("./main.tsx");
}
