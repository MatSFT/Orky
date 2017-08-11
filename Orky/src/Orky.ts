import * as restify from "restify";
import * as SocketIO from "socket.io";
import {UniversalBot, ChatConnector, IMiddlewareMap, IEvent, Session} from "botbuilder";
import {ConsoleLogger} from "./logging/ConsoleLogger";
import {ILogger} from "./logging/Interfaces";
import {Config} from "./config/Config";
import {IConfig} from "./config/Interfaces";
import {BotFileRepository} from "./repositories/BotRepository"
import {BotService} from "./services/BotService"
import {BotMessageFormatter} from "./services/BotMessageFormatter"
import {Dialogs} from "./Dialogs";
import {ArgumentNullException} from "./Errors";


// Strip bot mentions from the message text
class TenantFilterMiddleware implements IMiddlewareMap {
  private _logger: ILogger;
  private _allowedTenants: string[];

  constructor(logger: ILogger, allowedTenants: string[]) {
    if (!logger) {
      throw new ArgumentNullException("logger");
    }
    this._logger = logger;

    this._allowedTenants = allowedTenants || [];
    this._allowedTenants = this._allowedTenants.map((tenantId) => tenantId.trim().toLowerCase());

    const tenantString = this._allowedTenants.length === 0 ? "All" : this._allowedTenants.join(", ");
    this._logger.info(`Restricting messages to tenants: ${tenantString}`);
  }

  public readonly receive = (event: IEvent, next: Function): void => {
    // No tenant filter means pass through all events.
    if (this._allowedTenants.length === 0) {
      return next();
    }

    // Filter the event out only if it came from the specified tenant.
    if (event && event.sourceEvent) {
      if (event.sourceEvent.tenant && event.sourceEvent.tenant.id as string) {
        const tenantId = event.sourceEvent.tenant.id as string;
        if (this._allowedTenants.includes(tenantId.toLowerCase())) {
          return next();
        }

        this._logger.warn(`Received message from unauthorized tenant '${tenantId}'.`);
      }
      else {
        this._logger.warn(`Received message without tenant data.`);
      }
    }
  }
}


// Strip bot mentions from the message text
class StripBotAtMentions implements IMiddlewareMap {
  public readonly botbuilder = (session: Session, next: Function): void => {
    const message = session.message;
    if (message) {
      const botMri = message.address.bot.id.toLowerCase();
      const botAtMentions = message.entities && message.entities.filter(
        (entity) => (entity.type === "mention") && (entity.mentioned.id.toLowerCase() === botMri));
      if (botAtMentions && botAtMentions.length) {
        // Save original text as property of the message
        (message as any).textWithBotMentions = message.text;
        // Remove the text corresponding to each mention
        message.text = botAtMentions.reduce((previousText, entity) => {
          return previousText.replace(entity.text, "").trim();
        }, message.text);
      }
    }
    next();
  }
}

export class Orky {
  private _config: IConfig;
  private _logger: ILogger;
  private _server: restify.Server;

  constructor(config: IConfig) {
    if (!config) {
      throw new ArgumentNullException("config");
    }

    this._config = config;
    this._logger = new ConsoleLogger(config.LogLevel);

    this._logger.info(`Created instance of Orky with config: ${JSON.stringify(this._config, null, 2)}`)
  }

  run(): void {
    const chatConnector = new ChatConnector({
      appId: this._config.MicrosoftAppId,
      appPassword: this._config.MicrosoftAppPassword
    });

    const botRepository = new BotFileRepository(this._logger, this._config.BotDataFilePath);
    const botService = new BotService(botRepository, this._logger, this._config.BotResponseTimeout);
    const botMessageFormatter = new BotMessageFormatter();
    
    const universalBot = Dialogs.register(chatConnector, botService, botMessageFormatter, this._logger);
    universalBot.use(new TenantFilterMiddleware(this._logger, this._config.MicrosoftTenantFilter));
    universalBot.use(new StripBotAtMentions());
    universalBot.set('localizerSettings', {
      defaultLocale: this._config.DefaultLocale,
      botLocalePath: this._config.LocalePath
    })

    this._server = restify.createServer({
      name: this._config.Name,
      version: this._config.Version
    });
    this._server.post(this._config.MessagesEndpoint, chatConnector.listen());
    
    const io = SocketIO.listen((this._server as any).server);
    this._server.listen(this._config.ServerPort, () => {
      this._logger.info(`${this._server.name} listening to ${this._server.url}`); 
    });

    io.on('connection', (socket) => {
      botService.establishConnection(socket);
    });

    this._logger.info("Orky is running");
  }

  stop(): void {
    this._logger.info("Orky is shutting down");
    this._server.close();
  }
}

export function run(): void {
  const config = new Config();
  const orky = new Orky(config);
  orky.run();
}
