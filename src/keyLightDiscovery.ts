import { Logger } from 'homebridge';
import { Bonjour, Browser, Service as BonjourService } from 'bonjour-service';
import { isIPv4 } from 'net';

import { KeyLight } from './keyLight.js';

const REDISCOVERY_INTERVAL_MS = 60000;

/**
 * Discovers Key Lights on the network via mDNS.
 * A browser reports each light only once, so browsing is restarted periodically to report lights again with current connection data.
 */
export class KeyLightDiscovery {
  private readonly bonjour = new Bonjour();
  private browser?: Browser;

  constructor(
    private readonly log: Logger,
    private readonly useIP: boolean,
    private readonly onDiscovered: (light: KeyLight) => void,
  ) {}

  start() {
    this.browse();
    setInterval(() => this.browse(), REDISCOVERY_INTERVAL_MS);
  }

  private browse() {
    this.browser?.stop();
    this.browser = this.bonjour.find({ type: 'elg' }, (remoteService: BonjourService) => {
      this.log.debug('Discovered accessory:', remoteService.name);

      const hostname = this.useIP ? remoteService.addresses?.find((address) => isIPv4(address)) : remoteService.host;
      const mac = remoteService.txt?.id as string | undefined;
      if (hostname && mac) {
        this.onDiscovered({ hostname, port: remoteService.port, name: remoteService.name, mac });
      } else {
        this.log.debug('Ignoring incomplete mDNS record of', remoteService.name);
      }
    });
  }
}
