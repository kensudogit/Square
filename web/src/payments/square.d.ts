/**
 * Square Web Payments SDK の型定義。
 *
 * SDK は npm パッケージではなく CDN から読み込むため、型は自前で書く。
 * 使う範囲だけを定義してある（全 API を写経しても保守できないので）。
 */

export type TokenizeResult =
  | { status: "OK"; token: string; details?: unknown }
  | { status: "INVALID"; errors: SquareFieldError[] }
  | { status: "ABORT"; errors?: SquareFieldError[] };

export type SquareFieldError = {
  code?: string;
  message?: string;
  field?: string;
  type?: string;
};

export type SquareCard = {
  attach(target: HTMLElement | string): Promise<void>;
  /** 呼ばないと iframe が残り、再マウントで入力欄が二重になる */
  destroy(): Promise<void> | void;
  tokenize(): Promise<TokenizeResult>;
};

export type VerifyBuyerDetails = {
  /** ★ 主単位の文字列。Payments API の最小単位整数とは別物（¥1,000 -> "1000" / $10 -> "10.00"） */
  amount: string;
  currencyCode: string;
  intent: "CHARGE" | "STORE";
  billingContact: {
    givenName?: string;
    familyName?: string;
    email?: string;
    countryCode?: string;
    city?: string;
    addressLines?: string[];
    postalCode?: string;
  };
};

export type VerifyBuyerResult = {
  token: string;
  userChallenged: boolean;
};

export type SquarePayments = {
  card(options?: { style?: Record<string, unknown> }): Promise<SquareCard>;
  verifyBuyer(
    source: string,
    details: VerifyBuyerDetails,
  ): Promise<VerifyBuyerResult | undefined>;
};

declare global {
  interface Window {
    Square?: {
      payments(applicationId: string, locationId: string): SquarePayments;
    };
  }
}

export {};
