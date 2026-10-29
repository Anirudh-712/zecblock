import { buildPageMetadata, getBaseUrl } from '@/lib/seo';

const description = 'Explore Crosslink delegated-stake candidates, the next voting roster, and this node’s current vote and recent packet observations.';

export const metadata = buildPageMetadata({
  title: 'Zcash Crosslink Finalizers & Stake | ZecBlock',
  description,
  path: '/validators',
  index: false,
  networks: ['crosslink-testnet'],
  imageAlt: 'ZecBlock Zcash Crosslink finalizer roster',
});

export default function ValidatorsLayout({ children }: { children: React.ReactNode }) {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/validators`;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': `${url}#webpage`,
    url,
    name: 'Crosslink Finalizer Roster',
    description,
    isPartOf: { '@id': `${baseUrl}/#website` },
    publisher: { '@id': 'https://zecblock.com/#organization' },
  };

  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }} />{children}</>;
}
