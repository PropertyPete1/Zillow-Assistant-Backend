export type ScrapeFilters = {
  cityQuery?: string;
  zipCodes?: string[];
  maxPrice?: number;
  minBedrooms?: number;
  ownersOnly?: boolean; // default true
  skipAlreadyRented?: boolean;
  skipNoAgents?: boolean; // keep for legacy
};

export type Listing = {
  id: string;
  url: string;
  address?: string;
  price?: number;
  bedrooms?: number;
  description?: string;
  listedByRaw?: string;
  extractedNames?: string[];
  ownerName?: string;
  ownerConfidence?: number; // 0–1
  isLikelyCompany?: boolean;
  excludeReason?: string;
  sourceSignals: {
    hasAgentBadge?: boolean;
    hasMgmtKeywords?: string[];
    hasAptComplexSignals?: string[];
    domMarkers?: string[];
  };
  ts: string;
};

export type ScrapeResult = {
  included: Listing[];
  excluded: Listing[];
  summary: {
    total: number;
    kept: number;
    dropped: number;
    reasons: Record<string, number>;
  };
};


