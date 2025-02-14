import {
  Injectable,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  PG_CONNECTION,
  PAYPOINT_SCHEMA,
  PAYMENT_PROMISE_DEADLINE_MILLI_SECS,
  ORDER_EXPIRATION_MILLI_SECS,
  WERT_PRIV_KEY,
  WERT_ALLOWED_FIAT,
  TEZPAY_PAYPOINT_ADDRESS,
  SIMPLEX_API_KEY,
  SIMPLEX_API_URL,
  SIMPLEX_PUBLIC_KEY,
  SIMPLEX_WALLET_ID,
  SIMPLEX_ALLOWED_FIAT,
  STRIPE_PAYMENT_METHODS,
  STRIPE_CHECKOUT_ENABLED,
  STRIPE_SECRET,
  VAT_FALLBACK_COUNTRY_SHORT,
  STORE_FRONT_URL,
  ADDRESS_WHITELIST_ENABLED,
} from '../../constants.js';
import { UserService, CartMeta } from '../../user/service/user.service.js';
import { NftService } from '../../nft/service/nft.service.js';
import { MintService } from '../../nft/service/mint.service.js';
import ts_results from 'ts-results';
const { Err } = ts_results;
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  nowUtcWithOffset,
  isBottom,
  maybe,
  stringEnumValueIndex,
  stringEnumIndexValue,
  getClientIp,
} from '../../utils.js';
import {
  DbTransaction,
  withTransaction,
  withMutexLock,
  DbPool,
} from '../../db.module.js';
import Tezpay from 'tezpay-server';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { UserEntity } from '../../user/entity/user.types.js';
import {
  CurrencyService,
  BASE_CURRENCY,
  SUPPORTED_CURRENCIES,
} from 'kanvas-api-lib';
import { signSmartContractData } from '@wert-io/widget-sc-signer';
import { createRequire } from 'module';
import {
  PaymentProvider,
  PaymentProviderString,
  PaymentStatus,
  OrderInfo,
  OrderStatus,
  NftDeliveryInfo,
  NftDeliveryStatus,
} from '../entity/payment.entity.js';

import type { NftEntity } from '../../nft/entity/nft.entity.js';
import type {
  TezpayDetails,
  StripeDetails,
  WertDetails,
  SimplexDetails,
} from '../entity/payment.entity.js';
import {
  ICreatePaymentDetails,
  ICreatePaymentIntent,
  ICreateSimplexPaymentDetails,
  ICreateWertPaymentDetails,
  IRegisterPayment,
  PaymentIntentInternal,
  HandleCreatePaymentIntent,
} from './payment.types';
import { validateRequestedCurrency } from '../../paramUtils.js';

const require = createRequire(import.meta.url);
const stripe = require('stripe');

interface NftOrder {
  id: number;
  userId: number;
  userAddress: string;
  nfts: NftEntity[];
  expiresAt: number;
}

@Injectable()
export class PaymentService {
  stripe = STRIPE_SECRET ? stripe(STRIPE_SECRET) : undefined;
  signWertData: any =
    !isBottom(WERT_PRIV_KEY) && !isBottom(TEZPAY_PAYPOINT_ADDRESS)
      ? signSmartContractData
      : undefined;

  FINAL_STATES = [
    PaymentStatus.SUCCEEDED,
    PaymentStatus.CANCELED,
    PaymentStatus.TIMED_OUT,
  ];

  tezpay: any;

  constructor(
    @Inject(PG_CONNECTION) private conn: any,
    private readonly mintService: MintService,
    private readonly userService: UserService,
    private readonly nftService: NftService,
    readonly currencyService: CurrencyService,
  ) {
    this.tezpay = new Tezpay({
      paypoint_schema_name: PAYPOINT_SCHEMA,
      db_pool: conn,
      block_confirmations: 2,
    });
  }

  async webhookHandler(constructedEvent: any) {
    let paymentStatus: PaymentStatus;

    switch (constructedEvent.type) {
      case 'payment_intent.succeeded':
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        paymentStatus = PaymentStatus.SUCCEEDED;
        break;
      case 'payment_intent.processing':
        paymentStatus = PaymentStatus.PROCESSING;
        break;
      case 'payment_intent.canceled':
      case 'checkout.session.expired':
        paymentStatus = PaymentStatus.CANCELED;
        break;
      case 'payment_intent.payment_failed':
      case 'checkout.session.async_payment_failed':
        paymentStatus = PaymentStatus.FAILED;
        break;
      case 'payment_intent.created':
        paymentStatus = PaymentStatus.CREATED;
        break;
      default:
        Logger.error(`Unhandled event type ${constructedEvent.type}`);
        throw Err('Unknown stripe webhook event');
    }

    const externalPaymentId = constructedEvent.data.object.id;
    const paymentId = (
      await this.conn.query(
        `SELECT payment_id FROM payment WHERE external_payment_id = $1`,
        [externalPaymentId],
      )
    ).rows[0]['payment_id'];

    if (typeof paymentId === 'undefined') {
      Logger.warn(`unknown stripe external payment id ${externalPaymentId}`);
      return;
    }

    await this.updatePaymentStatus(paymentId, paymentStatus, false);
  }

  async handleCreatePaymentIntent({
    cookieSession,
    user,
    request,
    paymentProvider,
    currency,
    recreateNftOrder,
  }: HandleCreatePaymentIntent) {
    validateRequestedCurrency(currency);
    if (
      paymentProvider === PaymentProvider.TEST ||
      !Object.values(PaymentProvider).includes(paymentProvider)
    ) {
      throw new HttpException(
        `requested payment provider not available`,
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // extracting some fields from paymentIntent like this, best way to get the
      // spread syntax below to not pick them up (we don't want to expose these
      // fields in the response of this API call)
      const {
        clientIp,
        externalPaymentId,
        amountExclVat,
        purchaserCountry,
        ...paymentIntent
      } = await this.createPayment(
        user,
        cookieSession.uuid,
        paymentProvider,
        currency,
        getClientIp(request),
        recreateNftOrder,
      );
      const order = await this.getPaymentOrder(paymentIntent.id);

      return {
        ...paymentIntent,
        amountExclVat: this.currencyService.toFixedDecimals(
          paymentIntent.currency,
          amountExclVat,
        ),
        paymentDetails: paymentIntent.providerPaymentDetails,
        nfts: order.nfts,
        expiresAt: order.expiresAt,
      };
    } catch (err: any) {
      Logger.error(
        `Err on creating nft order (userId=${user.id}), err: ${err}`,
      );

      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        'unable to place the order',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async promisePaid(userId: number, paymentId: string) {
    const notFoundErr = new HttpException(
      'nft order not found',
      HttpStatus.BAD_REQUEST,
    );

    const order = await this.getPaymentOrder(paymentId);
    if (order.userId !== userId) {
      Logger.error(
        `user with id=${userId} is not allowed to promise-paid a payment of another user with id=${order.userId}`,
      );
      throw notFoundErr;
    }

    try {
      await this.updatePaymentStatus(paymentId, PaymentStatus.PROMISED);
    } catch (err: any) {
      let paymentStatus;

      try {
        paymentStatus = await this.getPaymentStatus(paymentId);
      } catch (_) {
        throw err;
      }
      if (
        ![PaymentStatus.PROCESSING, PaymentStatus.SUCCEEDED].includes(
          paymentStatus,
        )
      ) {
        throw err;
      }

      Logger.warn(`failed to update status to promised, err: ${err}`);
      return;
    }

    await withTransaction(this.conn, async (dbTx: DbTransaction) => {
      await dbTx.query(
        `
UPDATE nft_order
SET expires_at = greatest($2, expires_at)
WHERE id = $1
      `,
        [order.id, nowUtcWithOffset(PAYMENT_PROMISE_DEADLINE_MILLI_SECS)],
      );

      await this.userService.dropCartByOrderId(order.id, dbTx);
    });
  }

  async createPayment(
    usr: UserEntity,
    cookieSession: string,
    provider: PaymentProviderString,
    currency: string,
    clientIp: string,
    recreateOrder: boolean = false,
  ): Promise<PaymentIntentInternal> {
    await this.userService.ensureUserCartSession(usr.id, cookieSession);

    return await withTransaction(this.conn, async (dbTx: DbTransaction) => {
      // preventing this to be executed concurrently for a single user, to prevent difficult corner cases
      await dbTx.query(
        `SELECT 1 FROM kanvas_user WHERE address = $1 FOR UPDATE`,
        [usr.userAddress],
      );

      const orderId = await this.#createOrder(dbTx, usr.id, recreateOrder);
      const order = await this.#getOrder(orderId, currency, true, dbTx);
      const amountUnit: number = order.nfts.reduce(
        (sum, nft) => sum + Number(nft.price),
        0,
      );

      let paymentIntent = await this.#createPaymentIntent(
        {
          user: usr,
          provider,
          currency,
          amountUnit,
          clientIp,
        },
        order.nfts,
      );
      await this.#registerPayment({
        dbTx,
        nftOrderId: orderId,
        paymentIntent,
      });

      return paymentIntent;
    });
  }

  async #createOrder(
    dbTx: DbTransaction,
    userId: number,
    recreateOrder: boolean,
  ): Promise<number> {
    const cartSessionRes = await this.userService.getUserCartSession(
      userId,
      dbTx,
    );
    if (!cartSessionRes.ok || typeof cartSessionRes.val !== 'string') {
      Logger.warn(`cannot create order for userId=${userId}, no cart exists`);
      throw new HttpException(
        'cannot create order, cart empty',
        HttpStatus.BAD_REQUEST,
      );
    }
    const cartSession: string = cartSessionRes.val;

    const cartMeta = await this.userService.getCartMeta(cartSession, dbTx);
    if (typeof cartMeta === 'undefined') {
      Logger.warn(
        `cannot create order for userId=${userId} (cartSession=${cartSession}), no cart exists`,
      );
      throw new HttpException(
        'cannot create order, cart empty',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!isBottom(cartMeta.orderId)) {
      if (!recreateOrder) {
        return cartMeta.orderId!;
      }

      await this.cancelNftOrder(dbTx, cartMeta.orderId!);
    }

    const orderAt = new Date();
    const expireAt = nowUtcWithOffset(ORDER_EXPIRATION_MILLI_SECS);
    const orderQryRes = await dbTx.query(
      `
INSERT INTO nft_order (
  user_id, order_at, expires_at
)
VALUES ($1, $2, $3)
RETURNING id`,
      [userId, orderAt.toUTCString(), expireAt],
    );
    const nftOrderId: number = orderQryRes.rows[0]['id'];

    const orderNftsQry = await dbTx.query(
      `
INSERT INTO mtm_nft_order_nft (nft_order_id, nft_id)
SELECT $2, cart.nft_id
FROM mtm_cart_session_nft AS cart
WHERE cart_session_id = $1
        `,
      [cartMeta.id, nftOrderId],
    );
    if (orderNftsQry.rowCount === 0) {
      Logger.warn(
        `cannot create order for userId=${userId} (cartSession=${cartSession}), empty cart`,
      );
      throw new HttpException(
        'cannot create order, cart is empty',
        HttpStatus.BAD_REQUEST,
      );
    }

    await dbTx.query(
      `
UPDATE cart_session
SET order_id = $2
WHERE id = $1
        `,
      [cartMeta.id, nftOrderId],
    );

    return nftOrderId;
  }

  async #getOrder(
    orderId: number,
    currency: string = BASE_CURRENCY,
    inBaseUnit: boolean = false,
    dbTx: DbTransaction | DbPool = this.conn,
  ): Promise<NftOrder> {
    const qryRes = await dbTx.query(
      `
SELECT
  usr.id AS user_id,
  usr.address AS user_address,
  nft_order.expires_at,
  mtm.nft_id
FROM nft_order
JOIN kanvas_user AS usr
  ON usr.id = nft_order.user_id
JOIN mtm_nft_order_nft AS mtm
  ON mtm.nft_order_id = nft_order.id
WHERE nft_order.id = $1
      `,
      [orderId],
    );

    if (qryRes.rowCount === 0) {
      throw `no nft_order found with id=${orderId}`;
    }

    return {
      id: orderId,
      userId: qryRes.rows[0]['user_id'],
      userAddress: qryRes.rows[0]['user_address'],
      expiresAt: qryRes.rows[0]['expires_at'].getTime(),
      nfts: await this.nftService.findByIds(
        qryRes.rows.map((row: any) => row['nft_id']),
        undefined,
        'nft_id',
        'asc',
        currency,
        inBaseUnit,
      ),
    };
  }

  async getPaymentOrder(paymentId: string): Promise<NftOrder> {
    const orderId = await this.getPaymentOrderId(paymentId);
    return await this.#getOrder(orderId);
  }

  async getOrderInfo(usr: UserEntity, paymentId: string): Promise<OrderInfo> {
    const orderId = await this.getPaymentOrderId(paymentId);

    const [order, intents] = await Promise.all([
      this.#getOrder(orderId).catch((err) => {
        Logger.error(err);
        throw new HttpException(
          'err on getting order information',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }),
      this.#getOrderPaymentIntents(orderId),
    ]);

    if (order.userId !== usr.id) {
      Logger.error(
        `user with id=${usr.id} is not allowed to view order of another user with id=${order.userId}`,
      );
      throw new HttpException('nft order not found', HttpStatus.BAD_REQUEST);
    }

    const paymentStatus = this.furthestPaymentStatus(
      intents.map((intent) => intent.status),
    );

    let orderStatus: OrderStatus;
    let delivery: { [key: number]: NftDeliveryInfo } | undefined;
    switch (paymentStatus) {
      case PaymentStatus.CANCELED:
      case PaymentStatus.TIMED_OUT:
        orderStatus = OrderStatus.CANCELED;
        break;
      case PaymentStatus.FAILED:
      case PaymentStatus.CREATED:
      case PaymentStatus.PROMISED:
      case PaymentStatus.PROCESSING:
        orderStatus = OrderStatus.PENDING_PAYMENT;
        break;
      case PaymentStatus.SUCCEEDED:
        delivery = await this.#getOrderDeliveryInfo(order);

        orderStatus = OrderStatus.DELIVERED;
        if (
          Object.values(delivery).some(
            (nftDelivery) => nftDelivery.status !== NftDeliveryStatus.DELIVERED,
          )
        ) {
          orderStatus = OrderStatus.DELIVERING;
        }
        break;
      default:
        throw new Error(
          `failed to determin order status (order id=${orderId}): unknown furthest payment status ${paymentStatus}`,
        );
    }

    return <OrderInfo>{
      orderedNfts: order.nfts,
      paymentIntents: intents,
      orderStatus: orderStatus,
      delivery,
    };
  }

  async #getOrderDeliveryInfo(
    order: NftOrder,
  ): Promise<{ [key: number]: NftDeliveryInfo }> {
    const res: { [key: number]: NftDeliveryInfo } = {};
    for (const row of (
      await this.conn.query(
        `
SELECT
  order_nft_id,
  transfer_nft_id,
  op.state,
  op.included_in
FROM nft_order_delivery
LEFT JOIN peppermint.operations AS op
  ON op.id = transfer_operation_id
WHERE nft_order_id = $1
  AND order_nft_id = ANY($2)
      `,
        [order.id, order.nfts.map((nft) => nft.id)],
      )
    ).rows) {
      res[row['order_nft_id']] = {
        status: this.#peppermintStateToDeliveryStatus(row['state']),
        transferOpHash: maybe(row['included_in'], (x) => x),
        proxiedNft:
          row['transfer_nft_id'] !== row['order_nft_id']
            ? await this.nftService.byId(row['transfer_nft_id'])
            : undefined,
      };
    }
    return res;
  }

  async #getOrderPaymentIntents(orderId: number): Promise<
    [
      {
        paymentId: string;
        provider: PaymentProviderString;
        status: PaymentStatus;
      },
    ]
  > {
    return (
      await this.conn.query(
        `
SELECT
  payment_id,
  provider,
  status
FROM payment
WHERE nft_order_id = $1
      `,
        [orderId],
      )
    ).rows.map((row: any) => {
      return {
        paymentId: row['payment_id'],
        provider: row['provider'],
        status: row['status'],
      };
    });
  }

  async #createPaymentIntent(
    { user, provider, currency, amountUnit, clientIp }: ICreatePaymentIntent,
    nfts: NftEntity[],
  ): Promise<PaymentIntentInternal> {
    const { vatRate, ipCountry } = await this.#ipAddrVatRate(clientIp);

    let amount = this.currencyService.convertFromBaseUnit(currency, amountUnit);

    const id = uuidv4();

    const providerPaymentDetails = await this.#createPaymentDetails(
      {
        paymentId: id,
        user,
        provider,
        currency,
        amountUnit,
        clientIp,
      },
      nfts,
    );

    let externalPaymentId: string | undefined;
    switch (provider) {
      case PaymentProvider.STRIPE:
        externalPaymentId = (providerPaymentDetails as StripeDetails).id;
        break;
      case PaymentProvider.TEST:
        externalPaymentId = id;
        break;
    }

    return {
      id,

      currency,
      amount: this.currencyService.toFixedDecimals(currency, amount),

      amountExclVat: amount / (1 + vatRate),
      vatRate,
      clientIp,
      purchaserCountry: ipCountry,

      provider,
      providerPaymentDetails,

      externalPaymentId,
    };
  }

  async #createPaymentDetails(
    {
      paymentId,
      user,
      provider,
      currency,
      amountUnit,
      clientIp,
    }: ICreatePaymentDetails,
    nfts: NftEntity[],
  ) {
    switch (provider) {
      case PaymentProvider.TEZPAY:
        if (currency !== 'XTZ') {
          throw new HttpException(
            `currency (${currency}) is not supported for tezpay`,
            HttpStatus.BAD_REQUEST,
          );
        }
        return await this.#createTezPaymentDetails(paymentId, amountUnit);
      case PaymentProvider.STRIPE:
        return await this.#createStripePaymentDetails(
          paymentId,
          user,
          currency,
          amountUnit,
          nfts,
        );
      case PaymentProvider.WERT:
        const fiatCurrency = currency;

        // Always require receival of XTZ for WERT payments (Fiat is sent to
        // WERT by the customer, WERT then calls _our_ paypoint smart contract,
        // which finalizes the payment with the sent equivalent XTZ value to
        // us)
        const mutezAmount = Number(
          this.currencyService.convertToCurrency(
            this.currencyService.convertFromCurrency(
              this.currencyService.convertFromBaseUnit(currency, amountUnit),
              currency,
            ),
            'XTZ',
            true,
          ),
        );

        return await this.#createWertPaymentDetails({
          paymentId,
          userAddress: user.userAddress,
          fiatCurrency,
          mutezAmount,
        });
      case PaymentProvider.SIMPLEX:
        return await this.#createSimplexPaymentDetails({
          user,
          fiatCurrency: currency,
          amountUnit,
          clientIp,
        });
      case PaymentProvider.TEST:
        return undefined;
    }
  }

  async #createWertPaymentDetails({
    paymentId,
    userAddress,
    fiatCurrency,
    mutezAmount,
  }: ICreateWertPaymentDetails): Promise<WertDetails> {
    if (typeof this.signWertData === 'undefined') {
      throw new HttpException(
        'wert payment provider not supported by this API instance',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    if (!WERT_ALLOWED_FIAT.includes(fiatCurrency)) {
      throw new HttpException(
        `requested fiat (${fiatCurrency}) is not supported by Wert`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const tezpayDetails = await this.#createTezPaymentDetails(
      paymentId,
      mutezAmount,
    );

    const signedData = this.signWertData(
      {
        address: userAddress,
        commodity: 'XTZ',
        commodity_amount: this.currencyService.convertFromBaseUnit(
          'XTZ',
          mutezAmount,
        ),
        pk_id: 'key1',
        sc_id: Buffer.from(tezpayDetails.paypointMessage).toString('hex'),
        sc_address: TEZPAY_PAYPOINT_ADDRESS,
        sc_input_data: Buffer.from(
          `{
  "entrypoint": "pay",
  "value": {"string":"${tezpayDetails.paypointMessage}"}
}`,
        ).toString('hex'),
      },
      WERT_PRIV_KEY,
    );

    return {
      wertData: {
        ...signedData,
        currency: fiatCurrency,
      },
    };
  }

  async #createSimplexPaymentDetails({
    user,
    fiatCurrency,
    amountUnit,
    clientIp,
  }: ICreateSimplexPaymentDetails): Promise<SimplexDetails> {
    if (
      typeof SIMPLEX_API_URL === 'undefined' ||
      typeof SIMPLEX_API_KEY === 'undefined' ||
      typeof SIMPLEX_WALLET_ID === 'undefined'
    ) {
      throw new HttpException(
        'simplex payment provider not supported by this API instance',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    if (!SIMPLEX_ALLOWED_FIAT.includes(fiatCurrency)) {
      throw new HttpException(
        `requested fiat (${fiatCurrency}) is not supported by Simplex`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const decimals = SUPPORTED_CURRENCIES[fiatCurrency];
    const amount = (Number(amountUnit) * Math.pow(10, -decimals)).toFixed(
      decimals,
    );
    async function getSimplexQuoteId() {
      try {
        let quoteResponse = await axios.post(
          SIMPLEX_API_URL + '/wallet/merchant/v2/quote',
          {
            end_user_id: '' + user.id,
            digital_currency: 'USD-DEPOSIT',
            fiat_currency: 'USD',
            requested_currency: 'USD',
            requested_amount: Number(amount),
            wallet_id: SIMPLEX_WALLET_ID,
            client_ip: clientIp,
            payment_methods: ['credit_card'],
          },
          {
            headers: {
              Authorization: `ApiKey ${SIMPLEX_API_KEY}`,
            },
          },
        );
        return quoteResponse.data?.quote_id;
      } catch (error) {
        let errorMessage;
        if (error instanceof Error) {
          if (axios.isAxiosError(error) && error.response) {
            errorMessage = error.response?.data?.error || error.response?.data;
            let errors = error.response?.data?.errors;
            if (errors && typeof errors == 'object') {
              errorMessage =
                error.response?.data?.error +
                '---DETAILS:---' +
                JSON.stringify(errors);
            }
            Logger.warn('get quote ERROR' + errorMessage);
            throw new Error(
              `there is problem simplex api get quote please contact your backend services`,
            );
          } else {
            Logger.warn(
              'Unexpected error simplex api get quote instance of error',
              error.message,
            );
          }
        } else {
          Logger.warn('Unexpected error simplex api get quote');
        }
        throw new Error(
          `there is problem simplex api get quote please contact your backend services`,
        );
      }
    }
    let quoteId = await getSimplexQuoteId();

    const paymentId = uuidv4();
    const orderId = uuidv4();

    async function simplexPaymentRequest() {
      try {
        var paymentResponse = await axios.post(
          SIMPLEX_API_URL + '/wallet/merchant/v2/payments/partner/data',
          {
            account_details: {
              app_provider_id: SIMPLEX_WALLET_ID,
              app_version_id: '1.0.0',
              app_end_user_id: '' + user.id,
              app_install_date: user.createdAt
                ? new Date(user.createdAt * 1000).toISOString()
                : new Date().toISOString(),
              email: '', // TODO NO WAY ?
              phone: '', // TODO NO WAY ?
              signup_login: {
                timestamp: new Date().toISOString(),
                ip: clientIp,
              },
            },
            transaction_details: {
              payment_details: {
                quote_id: quoteId,
                payment_id: paymentId,
                order_id: orderId,
                destination_wallet: {
                  currency: 'USD-DEPOSIT',
                  address: user.userAddress,
                  tag: '',
                },
                original_http_ref_url: '', // TODO NO WAY ?
              },
            },
          },
          {
            headers: {
              Authorization: `ApiKey ${SIMPLEX_API_KEY}`,
            },
          },
        );
      } catch (error) {
        let errorMessage;
        if (error instanceof Error) {
          if (axios.isAxiosError(error) && error.response) {
            errorMessage = error.response?.data?.error || error.response?.data;
            let errors = error.response?.data?.errors;
            if (errors && typeof errors == 'object') {
              errorMessage =
                error.response?.data?.error +
                '---DETAILS:---' +
                JSON.stringify(errors);
            }
            Logger.warn('payment req ERROR' + errorMessage);
            throw new Error(
              `there is problem simplex api payment req please contact your backend services`,
            );
          } else {
            Logger.warn(
              'Unexpected error simplex api get quote instance of error',
              error.message,
            );
          }
        } else {
          Logger.warn('Unexpected error simplex api payment req');
        }
        throw new Error(
          `there is problem simplex api payment req please contact your backend services`,
        );
      }
      return paymentResponse;
    }

    let paymentResponse = await simplexPaymentRequest();

    if (!paymentResponse.data?.is_kyc_update_required) {
      throw new Error(
        `there is problem simplex api payment req please contact your backend services (payment req succeeded but response unsupported)`,
      );
    }

    return {
      simplexData: {
        paymentId: paymentId,
        orderId: orderId,
        publicApiKey: SIMPLEX_PUBLIC_KEY,
      },
    };
  }

  async #createStripePaymentDetails(
    paymentId: string,
    usr: UserEntity,
    currency: string,
    currencyUnitAmount: number,
    nfts: NftEntity[],
  ): Promise<StripeDetails> {
    if (typeof this.stripe === 'undefined') {
      throw new HttpException(
        'stripe payment provider not supported by this API instance',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    if (currency === 'XTZ') {
      throw new HttpException(
        'currency (XTZ) is not supported for stripe',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (STRIPE_CHECKOUT_ENABLED) {
      const session = await this.stripe.checkout.sessions.create({
        line_items: nfts.map((nft) => ({
          price_data: {
            currency: currency,
            product_data: {
              name: nft.name,
              description: nft.description,
              images: [nft.thumbnailUri].filter(Boolean),
            },
            unit_amount: nft.price,
            tax_behavior: 'inclusive',
          },
          quantity: 1,
        })),
        automatic_tax: { enabled: true },
        mode: 'payment',
        success_url: `${STORE_FRONT_URL}/order/${paymentId}`,
        cancel_url: `${STORE_FRONT_URL}/checkout`,
      });

      return {
        id: session.id,
        checkoutSessionUrl: session.url,
        amount: currencyUnitAmount.toFixed(0),
      };
    } else {
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: currencyUnitAmount,
        currency: currency,
        payment_method_types: STRIPE_PAYMENT_METHODS,
        description: nfts.map((nft) => nft.name).join('\n'),
      });

      if (typeof paymentIntent.client_secret === 'undefined') {
        const errShort = 'failed to create payment intent with stripe';
        Logger.error(
          `${errShort}, unexpected response from stripe.paymentIntents.create: ${JSON.stringify(
            paymentIntent,
          )}`,
        );
        throw new HttpException(errShort, HttpStatus.INTERNAL_SERVER_ERROR);
      }

      return {
        id: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: currencyUnitAmount.toFixed(0),
      };
    }
  }

  async #createTezPaymentDetails(
    paymentId: string,
    mutezAmount: number,
  ): Promise<TezpayDetails> {
    const tezpayIntent = await this.tezpay.init_payment({
      external_id: paymentId,
      mutez_amount: mutezAmount,
    });
    return {
      receiverAddress: tezpayIntent.receiver_address,
      paypointMessage: tezpayIntent.message,
      mutezAmount: mutezAmount,
    };
  }

  async #registerPayment({
    dbTx,
    nftOrderId,
    paymentIntent,
  }: IRegisterPayment) {
    try {
      if (
        await this.#orderHasProviderOpen(
          nftOrderId,
          paymentIntent.provider,
          dbTx,
        )
      ) {
        await this.cancelNftOrderPayment(nftOrderId, paymentIntent.provider);
      }
      await dbTx.query(
        `
INSERT INTO payment (
  payment_id, status, nft_order_id, provider, currency, amount, vat_rate, amount_excl_vat, client_ip, external_payment_id, purchaser_country
)
VALUES ($1, 'created', $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id`,
        [
          paymentIntent.id,
          nftOrderId,
          paymentIntent.provider,
          paymentIntent.currency,
          paymentIntent.amount,
          paymentIntent.vatRate,
          paymentIntent.amountExclVat,
          paymentIntent.clientIp,
          paymentIntent.externalPaymentId,
          paymentIntent.purchaserCountry,
        ],
      );
      if (
        (
          await dbTx.query(
            `
SELECT 1
FROM payment
WHERE NOT status = ANY($1)
GROUP BY nft_order_id, provider
HAVING count(1) > 1
      `,
            [this.FINAL_STATES],
          )
        ).rowCount > 0
      ) {
        throw `already/still active payment intent for this provider already exists`;
      }
    } catch (err: any) {
      Logger.error(
        `Err on storing payment intent in db (provider=${paymentIntent.provider}, paymentId=${paymentIntent.id}, nftOrderId=${nftOrderId}), err: ${err}`,
      );
      throw err;
    }
  }

  async #orderHasProviderOpen(
    orderId: number,
    provider: PaymentProviderString,
    dbTx: DbTransaction | DbPool = this.conn,
  ): Promise<boolean> {
    const qryRes = await dbTx.query(
      `
SELECT 1
FROM payment
WHERE nft_order_id = $1
  AND provider = $2
  AND NOT status = ANY($3)
      `,
      [orderId, provider, this.FINAL_STATES],
    );

    return qryRes.rowCount > 0;
  }

  async updatePaymentStatus(
    paymentId: string,
    newStatus: PaymentStatus,
    async_finalize = true,
  ) {
    const prevStatus = await withTransaction(
      this.conn,
      async (dbTx: DbTransaction) => {
        const qryPrevStatus = await dbTx.query(
          `
SELECT status
FROM payment
WHERE payment_id = $1
FOR UPDATE
        `,
          [paymentId],
        );
        if (qryPrevStatus.rowCount === 0) {
          throw `Cannot update payment status of unknown paymentId=${paymentId} (attempted new status was: ${newStatus})`;
        }
        const prevStatus = qryPrevStatus.rows[0]['status'];

        this.#assertStatusTransitionAllowed(prevStatus, newStatus);

        await dbTx.query(
          `
UPDATE payment
SET status = $1
WHERE payment_id = $2
  AND NOT status = ANY($3)
        `,
          [newStatus, paymentId, this.FINAL_STATES],
        );

        if (newStatus === PaymentStatus.PROCESSING) {
          const orderId = await this.getPaymentOrderId(paymentId, dbTx);
          await this.userService.dropCartByOrderId(orderId, dbTx);
        }

        return prevStatus;
      },
    ).catch((err: any) => {
      throw `Err on updating payment status in db (paymentId=${paymentId}, newStatus=${newStatus}), err: ${err}`;
    });

    Logger.log(`Payment with id=${paymentId}: ${prevStatus}->${newStatus}`);

    if (
      newStatus === PaymentStatus.SUCCEEDED &&
      !this.FINAL_STATES.includes(prevStatus)
    ) {
      const finalize = (async () => {
        try {
          const orderId = await this.getPaymentOrderId(paymentId);
          await this.#orderCheckout(orderId);

          // cancel other payment intents (if any)
          await withTransaction(this.conn, async (dbTx: DbTransaction) => {
            await this.cancelNftOrder(dbTx, orderId);
          });
        } catch (err: any) {
          Logger.error(err);
        }
      })();
      if (!async_finalize) {
        await finalize;
      }
    }
  }

  #assertStatusTransitionAllowed(
    prevStatus: PaymentStatus,
    newStatus: PaymentStatus,
  ) {
    if (
      newStatus === PaymentStatus.PROMISED &&
      [...this.FINAL_STATES, PaymentStatus.PROCESSING].includes(prevStatus)
    ) {
      throw `Cannot update status to promised from ${prevStatus}`;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async deleteExpiredPayments() {
    await withMutexLock({
      mutexName: 'deleteExpiredPayments',
      dbPool: this.conn,
      onLockedReturn: null,
      f: async () => {
        const cancelOrderIds = await this.conn.query(
          `
SELECT
  nft_order.id AS nft_order_id,
  nft_order.expires_at,
  payment.provider
FROM nft_order
JOIN payment
  ON payment.nft_order_id = nft_order.id
WHERE nft_order.expires_at <= now() AT TIME ZONE 'UTC'
  AND payment.status IN ('created', 'promised', 'failed')
ORDER BY 1
    `,
        );

        for (const row of cancelOrderIds.rows) {
          const orderId = Number(row['nft_order_id']);
          const provider = row['provider'];
          await this.cancelNftOrderPayment(
            orderId,
            provider,
            PaymentStatus.TIMED_OUT,
          );
          Logger.warn(`canceled following expired order session: ${orderId}`);
        }
      },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkPendingTezpays() {
    await withMutexLock({
      mutexName: 'checkPendingTezpays',
      dbPool: this.conn,
      onLockedReturn: null,
      f: async () => {
        const pendingPaymentIds = await this.conn.query(
          `
SELECT
  payment_id
FROM payment
WHERE provider IN ('tezpay', 'wert')
  AND status IN ('created', 'promised')
ORDER BY 1
    `,
        );

        for (const row of pendingPaymentIds.rows) {
          const paymentId = row['payment_id'];
          const paymentStatus = await this.tezpay.get_payment(paymentId);

          if (paymentStatus.is_paid_in_full) {
            await this.updatePaymentStatus(
              paymentId,
              PaymentStatus.SUCCEEDED,
              false,
            );
            Logger.log(`tezpay succeeded. payment_id=${paymentId}`);
          }
        }
      },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkPendingSimplex() {
    await withMutexLock({
      mutexName: 'checkPendingSimplex',
      dbPool: this.conn,
      onLockedReturn: null,
      f: async () => {
        const pendingPaymentIds = await this.conn.query(
          `
SELECT
  payment_id
FROM payment
WHERE provider = 'simplex'
  AND status IN ('created', 'promised')
    `,
        );
        if (pendingPaymentIds.rowCount === 0) {
          return;
        }

        async function getSimplexEvents() {
          try {
            let eventsResponse = await axios.get(
              SIMPLEX_API_URL + '/wallet/merchant/v2/events',
              {
                headers: {
                  Authorization: `ApiKey ${SIMPLEX_API_KEY}`,
                },
              },
            );
            return eventsResponse.data;
          } catch (error) {
            let errorMessage;
            if (error instanceof Error) {
              if (axios.isAxiosError(error) && error.response) {
                errorMessage =
                  error.response?.data?.error || error.response?.data;
                let errors = error.response?.data?.errors;
                if (errors && typeof errors == 'object') {
                  errorMessage =
                    error.response?.data?.error +
                    '---DETAILS:---' +
                    JSON.stringify(errors);
                }
                Logger.warn('getSimplexEvents ERROR' + errorMessage);
                throw new Error(
                  `there is problem simplex api getSimplexEvents please contact your backend services`,
                );
              } else {
                Logger.warn(
                  'Unexpected error simplex api getSimplexEvents instance of error',
                  error.message,
                );
              }
            } else {
              Logger.warn('Unexpected error simplex api getSimplexEvents');
            }
            throw new Error(
              `there is problem simplex api getSimplexEvents please contact your backend services`,
            );
          }
        }

        async function deleteSimplexEvents(eventId: string) {
          try {
            let eventsResponse = await axios.delete(
              SIMPLEX_API_URL + '/wallet/merchant/v2/events/' + eventId,
              {
                headers: {
                  Authorization: `ApiKey ${SIMPLEX_API_KEY}`,
                },
              },
            );
            return eventsResponse.data;
          } catch (error) {
            let errorMessage;
            if (error instanceof Error) {
              if (axios.isAxiosError(error) && error.response) {
                errorMessage =
                  error.response?.data?.error || error.response?.data;
                let errors = error.response?.data?.errors;
                if (errors && typeof errors == 'object') {
                  errorMessage =
                    error.response?.data?.error +
                    '---DETAILS:---' +
                    JSON.stringify(errors);
                }
                Logger.warn('getSimplexEvents ERROR' + errorMessage);
              } else {
                Logger.warn(
                  'Unexpected error simplex api deleteSimplexEvents instance of error',
                  error.message,
                );
              }
            } else {
              Logger.warn('Unexpected error simplex api deleteSimplexEvents');
            }
          }
        }

        function getSimplexPaymentStatus(event: { name: any }) {
          let paymentStatus: PaymentStatus;
          switch (event?.name) {
            case 'payment_simplexcc_approved':
              paymentStatus = PaymentStatus.SUCCEEDED;
              break;
            case 'payment_simplexcc_declined':
              paymentStatus = PaymentStatus.FAILED;
              break;
            default:
              Logger.error(`Unhandled payment status ${event?.name}`);
              throw Err('Unknown simplex events');
          }
          return paymentStatus;
        }

        let eventsResponse = await getSimplexEvents();
        for (const row of pendingPaymentIds.rows) {
          const paymentId = row['payment_id'];

          let events = eventsResponse?.events?.filter(
            (item: { payment: { id: string } }) => {
              return item?.payment?.id == paymentId;
            },
          );

          let event = events.pop();

          if (!event) {
            Logger.warn(
              'isPaidSimplex there is no event for paymentId: ' + paymentId,
            );
            throw Err('there is no simplex event');
          }

          const paymentStatus = getSimplexPaymentStatus(event);

          await this.updatePaymentStatus(paymentId, paymentStatus);
          Logger.log(
            `simplex payment ended. payment_id=${paymentId} paymentStatus:${paymentStatus}`,
          );

          events.push(event);
          for (const event1 of events) {
            let deleteResponse = await deleteSimplexEvents(event1.event_id);
            if (deleteResponse?.status == 'OK') {
              Logger.log(
                `simplex payment DELETE event succeeded. eventId=${event1.event_id} paymentId=${paymentId}`,
              );
            } else {
              Logger.warn(
                `simplex payment DELETE event failed. eventId=${event1.event_id} paymentId=${paymentId}`,
              );
            }
          }
        }
      },
    });
  }

  async cancelNftOrder(
    dbTx: DbTransaction,
    orderId: number,
    newStatus:
      | PaymentStatus.CANCELED
      | PaymentStatus.TIMED_OUT = PaymentStatus.CANCELED,
  ) {
    const openPaymentsQryResp = await dbTx.query(
      `
SELECT provider
FROM payment
WHERE nft_order_id = $1
  AND NOT status = ANY($2)
      `,
      [orderId, this.FINAL_STATES],
    );

    await Promise.all(
      openPaymentsQryResp.rows.map(
        async (row) =>
          await this.cancelNftOrderPayment(orderId, row['provider'], newStatus),
      ),
    );
  }

  async cancelNftOrderPayment(
    orderId: number,
    provider: PaymentProviderString,
    newStatus:
      | PaymentStatus.CANCELED
      | PaymentStatus.TIMED_OUT = PaymentStatus.CANCELED,
  ) {
    try {
      await withTransaction(this.conn, async (dbTx: DbTransaction) => {
        const payment = await dbTx.query(
          `
UPDATE payment
SET status = $3
WHERE nft_order_id = $1
  AND provider = $2
  AND NOT status = ANY($4)
RETURNING COALESCE(external_payment_id, payment_id) AS payment_id
      `,
          [orderId, provider, newStatus, this.FINAL_STATES],
        );

        if (payment.rowCount === 0) {
          throw Err(
            `paymentIntentCancel failed (orderId=${orderId}, provider=${provider}), err: no payment exists with matching orderId and cancellable status`,
          );
        }

        const paymentId = payment.rows[0]['payment_id'];

        switch (provider) {
          // we could not add SIMPLEX. Because Simplex Team does not support cancel payment.
          case PaymentProvider.STRIPE:
            if (STRIPE_CHECKOUT_ENABLED) {
              await this.stripe.checkout.sessions.expire(paymentId);
            } else {
              await this.stripe.paymentIntents.cancel(paymentId);
            }
            break;
          case PaymentProvider.TEZPAY:
          case PaymentProvider.WERT:
            await this.tezpay.cancel_payment(paymentId);
            break;
        }
      });
    } catch (err: any) {
      Logger.error(
        `Err on canceling nft order (orderId=${orderId}, provider=${provider}), err: ${err}`,
      );
    }
  }

  async getPaymentOrderId(
    paymentId: string,
    dbTx: DbTransaction | DbPool = this.conn,
  ): Promise<number> {
    const qryRes = await dbTx.query(
      `
SELECT nft_order_id
FROM payment
WHERE payment_id = $1
      `,
      [paymentId],
    );
    return qryRes.rows[0]['nft_order_id'];
  }

  async getPaymentStatus(
    paymentId: string,
    dbTx: DbTransaction | DbPool = this.conn,
  ): Promise<PaymentStatus> {
    const qryRes = await dbTx.query(
      `
SELECT status
FROM payment
WHERE payment_id = $1
      `,
      [paymentId],
    );
    return qryRes.rows[0]['status'];
  }

  async #orderCheckout(orderId: number) {
    const order = await this.#getOrder(orderId);
    let nfts = await this.#unfoldProxyNfts(orderId, order.nfts);

    if (ADDRESS_WHITELIST_ENABLED) {
      try {
        await this.#markWhitelistedAddressClaimed(order.userId);
      } catch (err: any) {
        Logger.error(
          `failed to mark whitelisted addresses devil claim, err: ${JSON.stringify(
            err,
          )}`,
        );
        // Note: dont throw err, just continue. Better to not break the Nft sending due to an err here (last minute code)
      }
    }

    nfts = await withTransaction(this.conn, async (dbTx: DbTransaction) => {
      await this.#assignNftsToUser(
        dbTx,
        order.userId,
        Object.values(nfts).map((nft: NftEntity) => nft.id),
      );

      return nfts;
    }).catch((err: any) => {
      Logger.error(
        `failed to checkout order (orderId=${orderId}), err: ${err}`,
      );
      throw err;
    });
    this.userService.dropCartByOrderId(orderId);

    // This step is done after committing the database related assigning of the
    // NFTs to the user, if any issues occur with Blockchain related assigning
    // they should be resolved asynchronously
    const opIds = await this.mintService.transferNfts(
      Object.values(nfts),
      order.userAddress,
    );
    await this.#registerTransfers(orderId, nfts, opIds);
  }

  async #markWhitelistedAddressClaimed(userId: number) {
    await this.conn.query(
      `
UPDATE whitelisted_wallet_addresses
SET claimed = claimed + 1
WHERE address = (SELECT address FROM kanvas_user WHERE id = $1)
`,
      [userId],
    );
  }

  async #registerTransfers(
    orderId: number,
    nfts: { [key: number]: NftEntity },
    opIds: { [key: number]: number },
  ) {
    await withTransaction(this.conn, async (dbTx: DbTransaction) => {
      for (const orderedNftId of Object.keys(nfts).map(Number)) {
        const transferNft = nfts[orderedNftId];
        let transferOpId = opIds[transferNft.id];

        await dbTx.query(
          `
INSERT INTO nft_order_delivery (
  nft_order_id, order_nft_id, transfer_operation_id, transfer_nft_id
)
VALUES ($1, $2, $3, $4)
          `,
          [orderId, orderedNftId, transferOpId, transferNft.id],
        );
      }
    });
  }

  async #unfoldProxyNfts(
    orderId: number,
    nfts: NftEntity[],
  ): Promise<{ [key: number]: NftEntity }> {
    return await withTransaction(this.conn, async (dbTx: DbTransaction) => {
      await dbTx.query('LOCK TABLE proxy_unfold IN EXCLUSIVE MODE');

      const res: { [key: number]: NftEntity } = {};
      for (const nft of nfts) {
        if (!nft.isProxy) {
          res[nft.id] = nft;
          continue;
        }

        const unfoldId = (
          await dbTx.query(
            `
UPDATE proxy_unfold
SET claimed = true,
    claimed_for_order = $2
WHERE proxy_nft_id = $1
  AND NOT claimed
  AND id = (
    SELECT min(id)
    FROM proxy_unfold
    WHERE proxy_nft_id = $1
      AND NOT claimed
  )
RETURNING unfold_nft_id
        `,
            [nft.id, orderId],
          )
        ).rows[0]['unfold_nft_id'];

        res[nft.id] = await this.nftService.byId(unfoldId);
      }
      return res;
    });
  }

  async #assignNftsToUser(dbTx: any, userId: number, nftIds: number[]) {
    await dbTx.query(
      `
INSERT INTO mtm_kanvas_user_nft (
  kanvas_user_id, nft_id
)
SELECT $1, UNNEST($2::int[])
`,
      [userId, nftIds],
    );
  }

  // Test function
  async getPaymentForLatestUserOrder(
    userId: number,
  ): Promise<{ paymentId: string; orderId: number; status: PaymentStatus }> {
    const qryRes = await this.conn.query(
      `
SELECT payment_id, status, nft_order.id as order_id
FROM payment
JOIN nft_order
ON nft_order.id = payment.nft_order_id
WHERE nft_order_id = (
  SELECT nft_order.id as order_id
  FROM nft_order
  WHERE user_id = $1
  ORDER BY nft_order.id DESC
  LIMIT 1
)
ORDER BY payment.id DESC
      `,
      [userId],
    );

    return {
      paymentId: qryRes.rows[0]['payment_id'],
      orderId: qryRes.rows[0]['order_id'],
      status: qryRes.rows[0]['status'],
    };
  }

  #peppermintStateToDeliveryStatus(state: string): NftDeliveryStatus {
    switch (state) {
      case 'pending':
        return NftDeliveryStatus.INITIATING;
      case 'processing':
      case 'waiting':
        return NftDeliveryStatus.DELIVERING;
      case 'confirmed':
        return NftDeliveryStatus.DELIVERED;
      case 'unknown':
      case 'rejected':
      case 'failed':
      case 'lost':
      case 'canary':
        return NftDeliveryStatus.UNKNOWN;
      default:
        throw new Error(
          `could not determine nft delivery status: unknown peppermint state ${state}`,
        );
    }
  }

  furthestPaymentStatus(statuses: PaymentStatus[]): PaymentStatus | undefined {
    return stringEnumIndexValue(
      PaymentStatus,
      Math.max(
        ...statuses.map(
          (status) => stringEnumValueIndex(PaymentStatus, status) ?? 0,
        ),
      ),
    );
  }

  // Note: returned value is a rate between 0 and 1 (with 1 translating to 100%)
  async #ipAddrVatRate(
    ipAddr: string,
  ): Promise<{ vatRate: number; ipCountry: string }> {
    const ip: number = this.ipAddrToNum(ipAddr);

    const qryRes = await this.conn.query(
      `
SELECT
  country.country_short,
  country.vat_id IS NOT NULL AS vat_rate_defined
FROM ip_country
LEFT JOIN country
  ON country.id = ip_country.country_id
WHERE ip_country.ip_from <= $1
  AND ip_country.ip_to >= $1
      `,
      [ip],
    );

    const ipCountryShort = qryRes.rows[0]?.['country_short'];
    let vatCountryShort = ipCountryShort;
    if (isBottom(vatCountryShort)) {
      Logger.warn(
        `Unmapped country for ip address ${ipAddr}, falling back to ${VAT_FALLBACK_COUNTRY_SHORT}`,
      );
      vatCountryShort = VAT_FALLBACK_COUNTRY_SHORT;
    } else if (!qryRes.rows[0]['vat_rate_defined']) {
      Logger.warn(
        `Unmapped vat for ${ipCountryShort}, falling back to ${VAT_FALLBACK_COUNTRY_SHORT}`,
      );
      vatCountryShort = VAT_FALLBACK_COUNTRY_SHORT;
    }

    return {
      ipCountry: ipCountryShort,
      vatRate: await this.#countryVatRate(
        vatCountryShort ?? VAT_FALLBACK_COUNTRY_SHORT,
      ),
    };
  }

  async #countryVatRate(countryShort: string): Promise<number> {
    const qryRes = await this.conn.query(
      `
SELECT
  vat.percentage
FROM country
LEFT JOIN vat
  ON vat.id = country.vat_id
WHERE country_short = $1
      `,
      [countryShort],
    );

    const vatPercentage = qryRes.rows[0]?.['percentage'];
    if (isBottom(vatPercentage)) {
      throw `Unmapped vat rate for country short '${countryShort}'`;
    }

    return vatPercentage / 100;
  }

  ipAddrToNum(ipAddr: string): number {
    const ipParts = ipAddr.split('.');
    return (
      ((+ipParts[0] * 256 + +ipParts[1]) * 256 + +ipParts[2]) * 256 +
      +ipParts[3]
    );
  }

  getCurrency(provider: PaymentProvider, currency: string): string {
    switch (provider) {
      case PaymentProvider.TEZPAY:
        return 'XTZ';
      case PaymentProvider.WERT:
        return 'USD';
      case PaymentProvider.SIMPLEX:
        return 'USD';
      case PaymentProvider.STRIPE:
        return currency === 'XTZ'
          ? BASE_CURRENCY === 'XTZ'
            ? 'USD'
            : BASE_CURRENCY
          : currency;
      default:
        return BASE_CURRENCY;
    }
  }
}
