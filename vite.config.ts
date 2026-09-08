import { defineConfig } from "vite";
import { profileById } from "./shared/profiles.ts";
import { profileViteConfig } from "./server/profile-config.ts";

// Vite reserves the literal mode name "local" for .env file suffixes.
export default defineConfig(({ mode }) => profileViteConfig(profileById(mode === "app-local" ? "local" : mode === "app-sepolia" ? "sepolia" : undefined).id));
