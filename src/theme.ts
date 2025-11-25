"use client";

import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#3b82f6" },
    secondary: { main: "#14b8a6" },
    error: { main: "#ef4444" },
    background: { default: "#0b0f14", paper: "#111827" },
    text: { primary: "#e5e7eb", secondary: "#9ca3af" },
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: [
      "Inter",
      "Roboto",
      "sans-serif",
      "Forever-Freedom-Regular",
    ].join(","),
  },
});
