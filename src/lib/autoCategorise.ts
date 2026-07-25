// Built-in auto-categorisation for unmistakable merchants. Deterministic,
// first-match-wins, and deliberately conservative: anything ambiguous returns
// null and stays flagged as uncategorised for the user to decide. Confirming
// a suggestion on the review screen turns it into a personal learned rule,
// which always takes priority over this list.

import type { Category } from '@/types/domain'

interface BuiltinRule {
  match: string[] // uppercase substrings; any hit applies
  merchant: string
  path: [string] | [string, string] // category, or [parent, subcategory]
}

// Order matters — more specific entries must come before broader ones
// (e.g. TESCO MOBILE before TESCO, UBER EATS before UBER, AMAZON PRIME before AMAZON).
const RULES: BuiltinRule[] = [
  // --- specific before general ---
  { match: ['TESCO MOBILE'], merchant: 'Tesco Mobile', path: ['Utilities', 'Mobile'] },
  { match: ['UBER EATS', 'UBEREATS'], merchant: 'Uber Eats', path: ['Eating out'] },
  { match: ['AMAZON PRIME', 'PRIME VIDEO'], merchant: 'Amazon Prime', path: ['Subscriptions'] },
  { match: ['SHELL ENERGY'], merchant: 'Shell Energy', path: ['Utilities', 'Energy'] },

  // --- coffee ---
  { match: ['STARBUCKS'], merchant: 'Starbucks', path: ['Coffee'] },
  { match: ['COSTA'], merchant: 'Costa Coffee', path: ['Coffee'] },
  { match: ['CAFFE NERO', 'CAFFÈ NERO'], merchant: 'Caffè Nero', path: ['Coffee'] },
  { match: ['PRET A MANGER', 'PRET AM'], merchant: 'Pret A Manger', path: ['Coffee'] },

  // --- groceries ---
  { match: ['TESCO'], merchant: 'Tesco', path: ['Groceries'] },
  { match: ['SAINSBURY'], merchant: "Sainsbury's", path: ['Groceries'] },
  { match: ['ASDA'], merchant: 'Asda', path: ['Groceries'] },
  { match: ['MORRISONS'], merchant: 'Morrisons', path: ['Groceries'] },
  { match: ['ALDI'], merchant: 'Aldi', path: ['Groceries'] },
  { match: ['LIDL'], merchant: 'Lidl', path: ['Groceries'] },
  { match: ['WAITROSE'], merchant: 'Waitrose', path: ['Groceries'] },
  { match: ['CO-OP', 'COOP GROUP'], merchant: 'Co-op', path: ['Groceries'] },
  { match: ['ICELAND'], merchant: 'Iceland', path: ['Groceries'] },
  { match: ['OCADO'], merchant: 'Ocado', path: ['Groceries'] },

  // --- eating out ---
  { match: ['MCDONALD'], merchant: "McDonald's", path: ['Eating out'] },
  { match: ['KFC'], merchant: 'KFC', path: ['Eating out'] },
  { match: ['BURGER KING'], merchant: 'Burger King', path: ['Eating out'] },
  { match: ['NANDO'], merchant: "Nando's", path: ['Eating out'] },
  { match: ['DOMINO'], merchant: "Domino's", path: ['Eating out'] },
  { match: ['PIZZA HUT'], merchant: 'Pizza Hut', path: ['Eating out'] },
  { match: ['SUBWAY'], merchant: 'Subway', path: ['Eating out'] },
  { match: ['GREGGS'], merchant: 'Greggs', path: ['Eating out'] },
  { match: ['DELIVEROO'], merchant: 'Deliveroo', path: ['Eating out'] },
  { match: ['JUST EAT', 'JUST-EAT'], merchant: 'Just Eat', path: ['Eating out'] },
  { match: ['FIVE GUYS'], merchant: 'Five Guys', path: ['Eating out'] },
  { match: ['WAGAMAMA'], merchant: 'Wagamama', path: ['Eating out'] },

  // --- fuel & transport ---
  { match: ['SHELL '], merchant: 'Shell', path: ['Transport', 'Fuel'] },
  { match: ['BP '], merchant: 'BP', path: ['Transport', 'Fuel'] },
  { match: ['ESSO'], merchant: 'Esso', path: ['Transport', 'Fuel'] },
  { match: ['TEXACO'], merchant: 'Texaco', path: ['Transport', 'Fuel'] },
  { match: ['TRAINLINE'], merchant: 'Trainline', path: ['Transport', 'Public transport'] },
  { match: ['TFL ', 'TFL.GOV', 'TRANSPORT FOR LONDON'], merchant: 'TfL', path: ['Transport', 'Public transport'] },
  { match: ['NATIONAL RAIL', 'NORTHERN RAIL', 'LNER', 'AVANTI', 'CROSSCOUNTRY'], merchant: 'Rail', path: ['Transport', 'Public transport'] },
  { match: ['STAGECOACH', 'ARRIVA', 'FIRST BUS'], merchant: 'Bus', path: ['Transport', 'Public transport'] },
  { match: ['UBER'], merchant: 'Uber', path: ['Transport'] },
  { match: ['RINGGO', 'NCP ', 'PAYBYPHONE', 'JUSTPARK'], merchant: 'Parking', path: ['Transport', 'Parking'] },

  // --- subscriptions & entertainment ---
  { match: ['NETFLIX'], merchant: 'Netflix', path: ['Subscriptions'] },
  { match: ['SPOTIFY'], merchant: 'Spotify', path: ['Subscriptions'] },
  { match: ['DISNEY PLUS', 'DISNEY+'], merchant: 'Disney+', path: ['Subscriptions'] },
  { match: ['APPLE.COM/BILL', 'APPLE.COM BILL'], merchant: 'Apple', path: ['Subscriptions'] },
  { match: ['YOUTUBE PREMIUM', 'YOUTUBEPREMIUM'], merchant: 'YouTube Premium', path: ['Subscriptions'] },
  { match: ['AUDIBLE'], merchant: 'Audible', path: ['Subscriptions'] },
  { match: ['NOW TV', 'NOWTV'], merchant: 'NOW TV', path: ['Subscriptions'] },
  { match: ['PLAYSTATION', 'XBOX', 'NINTENDO'], merchant: 'Gaming', path: ['Entertainment'] },
  { match: ['CINEMA', 'ODEON', 'VUE ', 'CINEWORLD'], merchant: 'Cinema', path: ['Entertainment'] },

  // --- shopping ---
  { match: ['AMAZON', 'AMZN'], merchant: 'Amazon', path: ['Shopping'] },
  { match: ['EBAY'], merchant: 'eBay', path: ['Shopping'] },
  { match: ['ARGOS'], merchant: 'Argos', path: ['Shopping'] },
  { match: ['B&Q', 'B AND Q'], merchant: 'B&Q', path: ['Housing', 'Household'] },
  { match: ['SCREWFIX'], merchant: 'Screwfix', path: ['Housing', 'Household'] },
  { match: ['IKEA'], merchant: 'IKEA', path: ['Housing', 'Household'] },
  { match: ['JOHN LEWIS'], merchant: 'John Lewis', path: ['Shopping'] },
  { match: ['PRIMARK'], merchant: 'Primark', path: ['Shopping', 'Clothing'] },
  { match: ['NEXT RETAIL', 'NEXT.CO.UK'], merchant: 'Next', path: ['Shopping', 'Clothing'] },
  { match: ['SPORTS DIRECT', 'SPORTSDIRECT'], merchant: 'Sports Direct', path: ['Shopping'] },
  { match: ['JD SPORTS'], merchant: 'JD Sports', path: ['Shopping'] },
  { match: ['ASOS'], merchant: 'ASOS', path: ['Shopping', 'Clothing'] },
  { match: ['ZARA'], merchant: 'Zara', path: ['Shopping', 'Clothing'] },
  { match: ['H&M', 'H & M'], merchant: 'H&M', path: ['Shopping', 'Clothing'] },
  { match: ['SHEIN'], merchant: 'SHEIN', path: ['Shopping', 'Clothing'] },
  { match: ['TEMU'], merchant: 'Temu', path: ['Shopping'] },
  { match: ['CURRYS'], merchant: 'Currys', path: ['Shopping'] },

  // --- utilities ---
  { match: ['BRITISH GAS'], merchant: 'British Gas', path: ['Utilities', 'Energy'] },
  { match: ['OCTOPUS ENERGY'], merchant: 'Octopus Energy', path: ['Utilities', 'Energy'] },
  { match: ['EDF ENERGY', 'E.ON', 'EON NEXT', 'OVO ENERGY', 'SCOTTISH POWER'], merchant: 'Energy', path: ['Utilities', 'Energy'] },
  { match: ['THAMES WATER', 'YORKSHIRE WATER', 'SEVERN TRENT', 'UNITED UTILITIES', 'ANGLIAN WATER'], merchant: 'Water', path: ['Utilities', 'Water'] },
  { match: ['VIRGIN MEDIA', 'PLUSNET', 'TALKTALK', 'BT GROUP', 'BT BROADBAND'], merchant: 'Broadband', path: ['Utilities', 'Broadband'] },
  { match: ['SKY DIGITAL', 'SKY SUBSCRIPTION'], merchant: 'Sky', path: ['Utilities', 'Broadband'] },
  { match: ['VODAFONE', 'O2 UK', 'EE LIMITED', 'EE & T-MOBILE', 'THREE.CO.UK', 'HUTCHISON 3G', 'GIFFGAFF', 'SMARTY'], merchant: 'Mobile', path: ['Utilities', 'Mobile'] },
  { match: ['COUNCIL TAX', 'COUNCIL'], merchant: 'Council tax', path: ['Utilities', 'Council tax'] },

  // --- health & fitness ---
  { match: ['BOOTS'], merchant: 'Boots', path: ['Health', 'Pharmacy'] },
  { match: ['SUPERDRUG'], merchant: 'Superdrug', path: ['Health', 'Pharmacy'] },
  { match: ['PUREGYM', 'PURE GYM'], merchant: 'PureGym', path: ['Health', 'Fitness'] },
  { match: ['THE GYM GROUP', 'JD GYMS', 'DAVID LLOYD', 'NUFFIELD'], merchant: 'Gym', path: ['Health', 'Fitness'] },

  // --- cash & fees ---
  { match: ['CASH WITHDRAWAL', 'ATM WITHDRAWAL', 'LINK ATM', 'CASH AT '], merchant: 'Cash withdrawal', path: ['Cash withdrawal'] },
  { match: ['MONTHLY ACCOUNT FEE', 'ACCOUNT FEE', 'OVERDRAFT FEE', 'INTEREST CHARGED'], merchant: 'Bank fees', path: ['Fees'] },
]

export interface AutoSuggestion {
  merchant: string
  path: [string] | [string, string]
}

/** Suggest a merchant + category for an unmistakable bank description.
 * Returns null when in any doubt — never guesses. */
export function suggestFromDescription(description: string): AutoSuggestion | null {
  const hay = ` ${description.toUpperCase()} `
  for (const rule of RULES) {
    if (rule.match.some((m) => hay.includes(m))) {
      return { merchant: rule.merchant, path: rule.path }
    }
  }
  return null
}

/** Resolve a suggestion's category path against the user's own categories. */
export function resolveCategoryId(categories: Category[], path: [string] | [string, string]): string | null {
  const parent = categories.find(
    (c) => !c.parent_id && c.name.toLowerCase() === path[0].toLowerCase(),
  )
  if (!parent) return null
  if (path.length === 1) return parent.id
  const sub = categories.find(
    (c) => c.parent_id === parent.id && c.name.toLowerCase() === path[1]!.toLowerCase(),
  )
  return sub?.id ?? parent.id
}
