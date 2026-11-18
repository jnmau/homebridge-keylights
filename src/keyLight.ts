import { CharacteristicValue, Logger } from 'homebridge';
import axios from 'axios';

const REQUEST_TIMEOUT_MS = 5000;
const UNREACHABLE_AFTER_MS = 30000;
const UNREACHABLE_POLLING_RATE_MS = 60000;

export interface KeyLight {
  hostname: string;
  port: number;
  name: string;
  mac: string;
}

// @todo improve this in future rewrite
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface KeyLightInstance extends KeyLight {
  settings?: KeyLightSettings;
  info?: KeyLightInfo;
  options?: KeyLightOptions;
}

export interface KeyLightSettings {
  powerOnBehavior: number;
  powerOnBrightness: number;
  powerOnTemperature: number;
  switchOnDurationMs: number;
  switchOffDurationMs: number;
  colorChangeDurationMs: number;
}

export interface KeyLightInfo {
  productName: string;
  hardwareBoardType: number;
  firmwareBuildNumber: number;
  firmwareVersion: string;
  serialNumber: string;
  displayName: string;
  features: Array<string>;
}

export interface KeyLightOptions {
  numberOfLights: number;
  lights: [{
      on: number;
      brightness: number;
      temperature: number;
  }];
}

// @todo improve this in future rewrite
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class KeyLightInstance {
  private constructor(keyLight: KeyLight, log: Logger, pollingRate: number) {
    this.hostname = keyLight.hostname;
    this.port = keyLight.port;
    this.name = keyLight.name;
    this.mac = keyLight.mac;

    this.log = log;
    this.pollingRate = pollingRate;
  }

  private readonly log: Logger;
  private readonly pollingRate: number;
  private lastResponseTime = 0;
  private _reachable = true;

  private _onPropertyChanged: (arg1: ('brightness' | 'on' | 'temperature'), arg2: number) => void = () => true;

  // Creates a new instance of a key light and pulls all neccessary data from the light
  public static async createInstance(data: KeyLight, log: Logger, pollingRate?: number): Promise<KeyLightInstance> {
    const result = new KeyLightInstance(data, log, pollingRate ?? 10000);
    result.info = (await axios.get<KeyLightInfo>(result.infoEndpoint, { timeout: REQUEST_TIMEOUT_MS })).data;
    result.options = (await axios.get<KeyLightOptions>(result.lightsEndpoint, { timeout: REQUEST_TIMEOUT_MS })).data;
    result.settings = (await axios.get<KeyLightSettings>(result.settingsEndpoint, { timeout: REQUEST_TIMEOUT_MS })).data;

    result.recordResponse();
    result.pollOptions();
    return result;
  }

  public get reachable(): boolean {
    return this._reachable;
  }

  public get serialNumber(): string {
    return this.info?.serialNumber ?? 'unknown';
  }

  public get manufacturer(): string {
    const str = this.info?.productName ?? 'unknown';
    return str.substr(0, str.indexOf(' '));
  }

  public get model(): string {
    return this.info?.productName ?? 'unknown';
  }

  public get displayName(): string {
    if (!this.info?.displayName) {
      return this.name;
    } else {
      return this.info.displayName === '' ? this.name : this.info.displayName;
    }
  }

  public get firmwareVersion(): string {
    return this.info?.firmwareVersion ?? '1.0';
  }

  public get endpoint(): string {
    return 'http://' + this.hostname + ':' + this.port + '/elgato/';
  }

  public get infoEndpoint(): string {
    return this.endpoint + 'accessory-info';
  }

  public get lightsEndpoint(): string {
    return this.endpoint + 'lights';
  }

  public get settingsEndpoint(): string {
    return this.lightsEndpoint + '/settings';
  }

  public get identifyEndpoint(): string {
    return this.endpoint + 'identify';
  }

  public set onPropertyChanged(callback: (arg1: ('brightness' | 'on' | 'temperature'), arg2: number) => void) {
    this._onPropertyChanged = callback;
  }

  public updateSettings(settings: KeyLightSettings) {
    axios.put<unknown>(this.settingsEndpoint, settings)
      .then(() => {
        axios.get<KeyLightSettings>(this.settingsEndpoint)
          .then((response) => {
            this.settings = response.data;
            this.log.debug('Updated device settings of', this.displayName);
          })
          .catch(() => {
            this.log.error('Pulling settings of', this.displayName, 'failed');
            this.settings = settings;
          });
      })
      .catch(() => {
        this.log.error('Updating settings of', this.displayName, 'failed');
      });
  }

  public identify() {
    axios.post<unknown>(this.identifyEndpoint)
      .catch((reason) => {
        this.log.error('Identifying', this.displayName, 'failed');
        this.log.debug('Reason:', String(reason));
      });
  }

  public async setProperty(property: ('brightness' | 'on' | 'temperature'), value: CharacteristicValue) {
    await axios.put<unknown>(this.lightsEndpoint, { 'lights': [{ [property]: value }] }, { timeout: REQUEST_TIMEOUT_MS });
    if (this.options) {
      this.options.lights[0][property] = value as number;
    }
    this.recordResponse();
  }

  public getProperty(property: ('brightness' | 'on' | 'temperature')) {
    return this.options?.lights[0][property] ?? 0;
  }

  private recordResponse() {
    this.lastResponseTime = Date.now();
    if (!this._reachable) {
      this._reachable = true;
      this.log.info(this.displayName, 'is reachable again');
    }
  }

  /**
   * The current state of the light is polled regularly. When a change is detected, the onPropertyChanged callback function
   * is called to update HomeKit.
   * Polls never overlap and slow down while the light is unreachable, as lights can stop responding entirely when flooded with requests.
   */
  private pollOptions() {
    const delay = this.reachable ? this.pollingRate : Math.max(this.pollingRate, UNREACHABLE_POLLING_RATE_MS);
    setTimeout(() => {
      axios.get<KeyLightOptions>(this.lightsEndpoint, { timeout: REQUEST_TIMEOUT_MS })
        .then(response => {
          if (this.options) {
            const oldLight = this.options.lights[0];
            const newLight = response.data.lights[0];

            if (oldLight.on !== newLight.on) {
              this._onPropertyChanged('on', newLight.on);
            }
            if (oldLight.temperature !== newLight.temperature) {
              this._onPropertyChanged('temperature', newLight.temperature);
            }
            if (oldLight.brightness !== newLight.brightness) {
              this._onPropertyChanged('brightness', newLight.brightness);
            }
          }
          this.options = response.data;
          this.recordResponse();
        })
        .catch((reason) => {
          // we'll retry again
          this.log.debug('Polling of', this.displayName, 'failed:', String(reason));
          if (this._reachable && Date.now() - this.lastResponseTime >= UNREACHABLE_AFTER_MS) {
            this._reachable = false;
            this.log.warn(this.displayName, 'is unreachable');
          }
        })
        .finally(() => this.pollOptions());
    }, delay);
  }
}
