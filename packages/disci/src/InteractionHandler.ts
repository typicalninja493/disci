import {
  APIInteraction,
  ApplicationCommandType,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import {
  HandlerOptions,
  defaultOptions,
  DiscordVerificationHeaders,
  InteractionContext,
  ClientEvents, 
  RequestEvents
} from "./utils/constants";
import nacl from "tweetnacl";
// to add typings to events
import { TypedEmitter } from "tiny-typed-emitter";
import { CommonHttpRequest, HandlerResponse, RequestTransformer, ResponseTransformer } from "./utils/transformers";

import { ChatInputCommandContext } from "./structures/context/ChatInputCommandContext";
import { DisciParseError, DisciValidationError, match, tryAndValue } from "./utils/helpers";
import { REST } from '@discordjs/rest';

export type callBackFunction = (data: HandlerResponse) => void;
const getRespondCallback = (resolve: Function, timeout: number, timeoutFunc: Function): callBackFunction => {
  const timer = setTimeout(() => timeoutFunc(resolve), timeout)
  return (data: HandlerResponse) => {
    clearTimeout(timer);
    return void resolve(data);
  }
}

export class InteractionHandler<Request extends CommonHttpRequest, Response> extends TypedEmitter<ClientEvents> {
  options: HandlerOptions;
  rest: REST | null;
  constructor(options: Partial<HandlerOptions>) {
    super();
    this.options = Object.assign({}, defaultOptions, options);
    // if rest is enabled
    this.rest = this.options.token ? new REST({ version: '10' }).setToken(this.options.token) : null
    if(!this.options.publicKey || typeof this.options.publicKey !== 'string') {
      console.warn(`VerifyOff (no publicKey): Running in debug mode, Requests will not be verified of thier origin (Disable This mode by passing your "publicKey" to options)`)
    }
  }
  /**
   * Handles a Request and returns a ResponseTransformer
   * @param Request the reques t from the server to handle
   * @param Response the object used to get information on the response
   * @param [verifyRequest = null]  a function that takes a {@link RequestTransformer} and returns a boolean on whether the request is a authorized request
   * @returns A Object containing Response Object
   */
  handleRequest(
    _req: Request,
    _res: Response,
    verifyRequest?: (req: RequestTransformer<Request>) => Promise<boolean>
  ): Promise<HandlerResponse> {
    // create our custom response/request transformers
    const req = new RequestTransformer<Request>(_req);
    const res = new ResponseTransformer<Response>(_res);
    return new Promise((resolve) => {
      // verify if its a valid request
      return (verifyRequest || this.verifyRequest.bind(this))(req).then((verified) => {
         if(verified) return this.processRequest(req, res).then(resolve)
         else return resolve(res.reply('Authorization invalid', 400))
      });
    });
  }
  /**
   * Process a request and return a response according to the request
   * this does not verify if request is valid or not
   * @param req 
   * @param res 
   */
  processRequest(req: RequestTransformer<Request>, res: ResponseTransformer<Response>): Promise<HandlerResponse> {
    return new Promise((resolve, reject) => {
        // this does not verify if request is valid or not
        const rawInteraction = tryAndValue<APIInteraction>(() => JSON.parse(req.rawBody));
        if(!rawInteraction) return reject(new DisciParseError(`Failed to parse rawBody into a valid ApiInteraction`));
        if(!this.verifyInteractionProperties(rawInteraction)) return reject(new DisciValidationError(`Expected Properties was not found on Request.body expected InteractionBody`))
        
        let interaction: null | InteractionContext = null;
        const callback = getRespondCallback(resolve, this.options.replyTimeout.timeout, () => {
          // timed out
          if(!interaction) return /* Unsupported Type */ resolve(res.reply(`Type ${rawInteraction.type} is not supported`, 500)) 
          if(match(this.options.replyTimeout, { action: 'defer' })) {
            interaction.replied = true;
            // auto defer
            return resolve(res.reply({ type: InteractionResponseType.DeferredChannelMessageWithSource }))
          }
          else interaction.timedOut = true;
        })

        switch(rawInteraction.type) {
          // handle pings
          case InteractionType.Ping:
            callback(res.reply({ type: InteractionResponseType.Pong }))
          break;
          // application commands
          case InteractionType.ApplicationCommand:
              // sub types
              switch(rawInteraction.data.type) {
                // chatinput / slash commands
                  case ApplicationCommandType.ChatInput:
                    interaction = new ChatInputCommandContext(rawInteraction, this, callback)
                  break;
              }
          break;
          default:
            // not supported
            callback(res.reply(`Type ${rawInteraction.type} is not supported`, 500))
          break;
        }

        // emit the event
        if(interaction) {
          this.emit(RequestEvents.interactionCreate, interaction)
        }
      })
  }
  /**
   * Verifies if the interaction received has All the Valid Properties
   * @param body 
   * @returns 
   */
  verifyInteractionProperties(body?: APIInteraction): Boolean {
    if(!body) return false;
    return Boolean(body.type && body.token && body.id)
  }
  /**
   * Verfies a request to validate if it originated from discord
   * https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
   */
  verifyRequest(req: RequestTransformer<any>): Promise<boolean> {
    return new Promise((resolve) => {
      // no public key yet (maybe not correctly attached)
      if (!this.options.publicKey) {
        console.warn(`VerifyOff (no publicKey): Automatic debug mode is running, this request is not validated`)
        return resolve(true)
      }
      const timestamp = req.headers[
        DiscordVerificationHeaders.TimeStamp
      ] as string;
      const signature = req.headers[
        DiscordVerificationHeaders.Signature
      ] as string;
      const { body } = req
      // all of them should be present
      if (!timestamp || !signature || !body) return resolve(false);
      try {
        return resolve(
          nacl.sign.detached.verify(
            Buffer.from(timestamp + body),
            Buffer.from(signature, "hex"),
            Buffer.from(this.options.publicKey, "hex")
          )
        );
      } catch {
        return resolve(false);
      }
    });
  }
}