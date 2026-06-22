import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Typeahead — Search Suggestions',
  description:
    'Low-latency search typeahead: in-memory completion Trie, distributed consistent-hashing cache, recency-aware trending, and batched writes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
