import type { CategoryEntity } from '../../category/entity/category.entity.js';

export interface OwnershipInfo {
  status: 'owned' | 'pending' | 'payment processing';
  receivalOperationHash?: string;
}

export interface NftEntity {
  id: number;
  createdAt: number;
  name: string;
  description: string;
  price: string;
  categories: CategoryEntity[];
  launchAt: number;
  editionsSize: number;
  editionsAvailable: number;
  metadata?: any;

  ipfsHash?: string; // deprecated by metadataIpfs field
  metadataIpfs?: string;
  artifactIpfs?: string;
  displayIpfs?: string;
  thumbnailIpfs?: string;

  artifactUri: string;
  displayUri?: string;
  thumbnailUri?: string;

  mintOperationHash?: string;
  ownerStatuses?: string[]; // deprecated by ownershipInfo
  ownershipInfo?: OwnershipInfo[];
}

export interface CreateNft {
  id: number;
  name: string;
  description: string;

  artifactUri: string;
  displayUri?: string;
  thumbnailUri?: string;

  price: number;
  categories: number[];
  editionsSize: number;

  onsaleFrom?: number;
  onsaleUntil?: number;

  metadata?: any;

  signature: string;
  secret: string;
}

export interface NftEntityPage {
  firstRequestAt: number; // in UTC UNIX
  nfts: NftEntity[];
  currentPage: number;
  numberOfPages: number;
  totalNftCount: number;
  lowerPriceBound: string;
  upperPriceBound: string;
}

export interface SearchResult {
  nfts: NftEntity[];
  categories: CategoryEntity[];
}
