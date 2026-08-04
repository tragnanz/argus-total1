import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Argus Total — Nabu",
  description: "Progettazione di grandi progetti agroindustriali con analisi satellitare.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
