"use client"

import { useEffect, type ReactNode } from "react"

// Light or dark follows the system setting, live. There is no toggle.
export function TaskThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const theme = query.matches ? "dark" : "light"
      document.documentElement.classList.toggle("dark", theme === "dark")
      document.documentElement.classList.toggle("light", theme === "light")
      document.documentElement.style.colorScheme = theme
    }
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])
  return children
}
