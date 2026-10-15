import { buildPageMetadata } from '@/lib/seo';

export const metadata = buildPageMetadata({
  title: 'Zcash Crosslink Finalizers & Stake | ZecBlock',
  description: 'Explore Crosslink delegated-stake candidates, the next voting roster, and this node’s current vote and recent packet observations.',
  path: '/validators',
  index: false,
  networks: ['crosslink-testnet'],
  imageAlt: 'ZecBlock Zcash Crosslink finalizer roster',
});

export default function ValidatorsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
