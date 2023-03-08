import { Logger } from '@nestjs/common'
import axios from 'axios'
export async function getFromDipdup(walletAddress: string) {
  const axiosTokenMetadataResponse = (await axios({
    url: `http://${process.env['HASURA_URL']}:8080/v1/graphql`,
    method: 'post',
    headers: { 'x-hasura-admin-secret': 'changeme' },
    data: {
      query: `query {
        create_token {
          contract
          counter
          hash
          id
          metadata
          metadata_uri
          timestamp
          token_id
        }
      }`
    }
  }))?.data
  Logger.warn(`dipdup token metadata: ${JSON.stringify(axiosTokenMetadataResponse)}`)
  if (axiosTokenMetadataResponse.data.errors?.length) {
    throw new Error(
      `error from hasura on create-token request: ${axiosTokenMetadataResponse.data.errors[0].message}`
    )
  }
  const axiosResponse = (await axios({
    url: `http://${process.env['HASURA_URL']}:8080/api/rest/get_user_by_address?address=${walletAddress}`,
    method: 'get',
    headers: { 'x-hasura-admin-secret': 'changeme' },
  }))?.data
  Logger.warn(`dipdup user by address: ${JSON.stringify(axiosResponse)}`)
  if (axiosResponse.data.errors?.length) {
    throw new Error(
      `error from hasura on get_user_by_address request: ${axiosResponse.data.errors[0].message}`
    )
  }

  const IPFS_GATEWAY = `https://cloudflare-ipfs.com/ipfs/`

  return axiosResponse.data.user.filter((u: any) => u.amount > 0).map((u: any) => {
    const create_token = axiosTokenMetadataResponse.data.create_token.find((ct: any) => ct.contract == u.contract && ct.token_id == u.token_id)
    if (create_token === undefined) throw new Error(`token metadata undefined: ${u.contract} ${u.token_id}`)
    const metadata = create_token.metadata
    const metadataUri = create_token.metadata_uri

    return {
      artifactIpfs: metadata.artifactUri,
      artifactUri: `${IPFS_GATEWAY}${metadata.artifactUri.split('ipfs://')[1]}`, // or cloudflare url?
      categories: [],
      createdAt: new Date(), // ??
      description: metadata.description,
      displayIpfs: metadata.displayUri,
      displayUri: `${IPFS_GATEWAY}${metadata.displayUri.split('ipfs://')[1]}`, // or cloudflare url?
      editionsAvailable: 0,
      editionsSize: 7777,
      editionsSold: u.amount,
      formats: {},
      id: u.token_id,
      ipfsHash: metadataUri,
      isProxy: false,
      metadata: {
        attributes: metadata.attributes
      },
      metadataIpfs: metadataUri,
      mintOperationHash: undefined, // ??
      name: metadata.name,
      ownerStatuses: ['owned'],
      ownershipInfo: [{
        status: "owned",
        receivalOperationHash: undefined // ??
      }],
      price: 0,
      proxyNftId: undefined,
      thumbnailIpfs: metadata.thumbnailUri,
      thumbnailUri: `${IPFS_GATEWAY}${metadata.thumbnailUri.split('ipfs://')[1]}`, // or cloudflare url?

      contractAddress: u.contract
    }
  })
}
