export async function getFromDipdup(walletAddress: string) {
  const axiosResponse = {
    data: {
      user: [
        {
          amount: 1,
          contract: 'KT1JUt1DNTsZC14KAxdSop34TWBZhvZ7P9a3',
          token_id: 1,
          metadataUri: 'ipfs://Qme7xzWWcCMcgu9g2eaEAfk6bJRHHRsUfF3AvYc8BDg1NN',
          metadata: {
            id: 1,
            name: '1/23 McLaren F1 Collectible',
            description: 'The first in the McLaren F1 Team 23/23 series, this Bahrain GP digital collectible incorporates famous landmarks and code stamps of the track and air temperature at the hottest Formula 1 race ever experienced in 2005. Collect all 23/23 to be in with a chance to receive an exclusive race experience and keep your eyes peeled for smaller collections and rewards. Powered by Tezos and brought to you by Tezos ecosystem companies. Terms apply: https://collectibles.mclaren.com/policies/terms',
            artifactUri: 'ipfs://QmQCBWyUJ3iaw8LfBDSHDKAfjjr9EcEheFdbLXNqBKNdiT',
            displayUri: 'ipfs://QmSnANJhxw1Jb36hspXxayDVnma5ec48xi4Qq1iuzqzxcr',
            thumbnailUri: 'ipfs://QmTB8g67SKZ2JQJVjNjSpXQSjWdCCgPcjDgmG4VuTxFF3R',
            formats: [
              {
                uri: 'ipfs://QmQCBWyUJ3iaw8LfBDSHDKAfjjr9EcEheFdbLXNqBKNdiT',
                mimeType: 'video/mp4'
              },
              {
                uri: 'ipfs://QmSnANJhxw1Jb36hspXxayDVnma5ec48xi4Qq1iuzqzxcr',
                mimeType: 'image/png',
                dimensions: {
                  unit: 'px',
                  value: '1260x1780'
                }
              },
              {
                uri: 'ipfs://QmTB8g67SKZ2JQJVjNjSpXQSjWdCCgPcjDgmG4VuTxFF3R',
                mimeType: 'image/png',
                dimensions: {
                  unit: 'px',
                  value: '248x350'
                }
              }
            ],
            tags: [
              'Sports'
            ],
            attributes: [{ name: 'someAttribute', value: 'someValue' }],
            minter: 'tz2W1hS4DURJckg7iZaLXL18kh8C3SJuUaxv',
            creators: [
              'tz2W1hS4DURJckg7iZaLXL18kh8C3SJuUaxv'
            ],
            publishers: [
              'Tezos'
            ],
            decimals: 0,
            isTransferable: true,
            isBooleanAmount: true,
            shouldPreferSymbol: false
          }
        }
      ]
    }
  }

  const IPFS_GATEWAY = `https://green-efficient-gazelle-590.mypinata.cloud/ipfs/`

  return axiosResponse.data.user.map((u) => {
    const formats = {
      artifact: {
        mimeType: u.metadata.formats[0].mimeType,
        dimensions: u.metadata.formats[0].dimensions,
      },
      display: {
        mimeType: u.metadata.formats[1].mimeType,
        dimensions: u.metadata.formats[1].dimensions,
      },
      thumbnail: {
        mimeType: u.metadata.formats[2].mimeType,
        dimensions: u.metadata.formats[2].dimensions,
      }
    };
  
    return {
      artifactIpfs: u.metadata.artifactUri,
      artifactUri: `${IPFS_GATEWAY}${u.metadata.artifactUri.split('ipfs://')[1]}`, // or cloudflare url?
      categories: [{
        description: 'Sports category',
        id: 1,
        name: 'Sports'
      }],
      createdAt: new Date(), // ??
      description: u.metadata.description,
      displayIpfs: u.metadata.displayUri,
      displayUri: `${IPFS_GATEWAY}${u.metadata.displayUri.split('ipfs://')[1]}`, // or cloudflare url?
      editionsAvailable: 0,
      editionsSize: 119526,
      editionsSold: u.amount, // is this correct?
      formats,
      id: u.token_id,
      ipfsHash: u.metadataUri,
      isProxy: false,
      metadata: {
        attributes: u.metadata.attributes
      },
      metadataIpfs: u.metadataUri,
      mintOperationHash: undefined, // ??
      name: u.metadata.name,
      ownerStatuses: ['owned'],
      ownershipInfo: [{
        status: "owned",
        receivalOperationHash: undefined // ??
      }],
      price: 0,
      proxyNftId: undefined,
      thumbnailIpfs: u.metadata.thumbnailUri,
      thumbnailUri: `${IPFS_GATEWAY}${u.metadata.thumbnailUri.split('ipfs://')[1]}`, // or cloudflare url?
    }
  })
}
