const { assert } = require('chai');

const delayForDuration = require('../helpers/delayForDuration');
const ServiceManagerTypes = require('../helpers/serviceManagerTypes');
const catchDelayCancelError = require('../helpers/catchDelayCancelError');
const BroadlinkRMAccessory = require('./accessory');

class DoorAccessory extends BroadlinkRMAccessory {

  setDefaults () {
    const { config, state } = this;
    const { currentPosition, positionState } = state;
    const { initialDelay, totalDurationOpen, totalDurationClose } = config;

    // Check required propertoes
    assert.isNumber(totalDurationOpen, '`totalDurationOpen` is required and should be numeric.')
    assert.isNumber(totalDurationClose, '`totalDurationClose` is required and should be numeric.')

    // Set config default values
    if (!initialDelay) {config.initialDelay = 0.1;}

    // Set state default values
    if (currentPosition === undefined) {this.state.currentPosition = 0;}
    if (positionState === undefined) {this.state.positionState = Characteristic.PositionState.STOPPED;}
  }

  async reset () {
    super.reset();

    // Clear existing timeouts
    if (this.initialDelayPromise) {
      this.initialDelayPromise.cancel();
      this.initialDelayPromise = null;
    }
    
    if (this.updateCurrentPositionPromise) {
      this.updateCurrentPositionPromise.cancel();
      this.updateCurrentPositionPromise = null;
    }
    
    if (this.autoStopPromise) {
      this.autoStopPromise.cancel();
      this.autoStopPromise = null;
    }

    if (this.autoCloseTimeoutPromise) {
      this.autoCloseTimeoutPromise.cancel();
      this.autoCloseTimeoutPromise = null
    }

  }

  // User requested a specific position or asked the door to be open or closed
  async setTargetPosition (hexData, previousValue) {
    await catchDelayCancelError(async () => {
      const { config, host, logLevel, data, log, name, state, serviceManager } = this;
      const { initialDelay } = config;
      const { open, close, stop } = data;
      
      this.reset();

      // Ignore if no change to the targetPosition
      if (state.targetPosition === previousValue && !config.allowResend) {return;}

      // `initialDelay` allows multiple `door` accessories to be updated at the same time
      // without RF interference by adding an offset to each `door` accessory
      // this.initialDelayPromise = delayForDuration(initialDelay);
      // await this.initialDelayPromise;

      const closeCompletely = await this.checkOpenOrCloseCompletely();
      if (closeCompletely) {return;}

      log(`${name} requested half state`);

      // Determine if we're opening or closing
      // let difference = state.targetPosition - state.currentPosition;

      // state.opening = (difference > 0);
      // if (!state.opening) {difference = -1 * difference;}

      // hexData = state.opening ? open : close

      // // Perform the actual open/close asynchronously i.e. without await so that HomeKit status can be updated
      // this.openOrClose({ hexData, previousValue });
    });
  }

  async openOrClose ({ hexData, previousValue }) {
    await catchDelayCancelError(async () => {
      let { config, data, host, name, log, state, logLevel, serviceManager } = this;
      let { totalDurationOpen, totalDurationClose } = config;
      const { stop } = data;

      const newPositionState = state.opening ? Characteristic.PositionState.INCREASING : Characteristic.PositionState.DECREASING;
      serviceManager.setCharacteristic(Characteristic.PositionState, newPositionState);

      log(`${name} setTargetPosition: currently ${state.currentPosition}%, moving to ${state.targetPosition}%`);

      await this.performSend(hexData);

      let difference = state.targetPosition - state.currentPosition
      if (!state.opening) {difference = -1 * difference;}

      const fullOpenCloseTime = state.opening ? totalDurationOpen : totalDurationClose;
      const durationPerPercentage = fullOpenCloseTime / 100;
      const totalTime = durationPerPercentage * difference;

      log(`${name} setTargetPosition: ${totalTime}s (${fullOpenCloseTime} / 100 * ${difference}) until auto-stop`);

      this.startUpdatingCurrentPositionAtIntervals();

      this.autoStopPromise = delayForDuration(totalTime);
      await this.autoStopPromise;

      await this.stopDoor();

      serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);
    });
  }

  async stopDoor () {
    const { config, data, host, log, name, state, logLevel, serviceManager } = this;
    const { sendStopAt0, sendStopAt100 } = config;
    const { stop } = data;
  
    log(`${name} setTargetPosition: (stop door)`);

    // Reset the state and timers
    this.reset();

    if (state.targetPosition === 100 && sendStopAt100) {await this.performSend(stop);}
    if (state.targetPosition === 0 && sendStopAt0) {await this.performSend(stop);}
    if (state.targetPosition !== 0 && state.targetPosition != 100) {await this.performSend(stop);}

    serviceManager.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
  }

  async checkOpenOrCloseCompletely () {
    const { config, data, logLevel, host, log, name, serviceManager, state } = this;
    const { openCompletely, closeCompletely } = data;
    let { autoCloseDelay } = config;

    // Completely Close
    if (state.targetPosition === 0 && closeCompletely) {
      serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);

      await this.performSend(closeCompletely);

      this.stopDoor();

      return true;
    }

    // Completely Open
    if (state.targetPosition === 100 && openCompletely) {
      serviceManager.setCharacteristic(Characteristic.CurrentPosition, state.targetPosition);

      await this.performSend(openCompletely);
      
      if (autoCloseDelay) {
        log(`${name} automatically closing in ${autoCloseDelay}s`);
        this.autoCloseTimeoutPromise = delayForDuration(autoCloseDelay);
        await this.autoCloseTimeoutPromise;
  
        serviceManager.setCharacteristic(Characteristic.TargetPosition, 0);
        serviceManager.setCharacteristic(Characteristic.CurrentPosition, 0);
        // this.lock()
      }

      this.stopDoor();

      return true;
    }

    return false;
  }

  // Determine how long it should take to increase/decrease a single %
  determineOpenCloseDurationPerPercent ({ opening, totalDurationOpen, totalDurationClose  }) {
    assert.isBoolean(opening);
    assert.isNumber(totalDurationOpen);
    assert.isNumber(totalDurationClose);
    assert.isAbove(totalDurationOpen, 0);
    assert.isAbove(totalDurationClose, 0);

    const fullOpenCloseTime = opening ? totalDurationOpen : totalDurationClose;
    const durationPerPercentage = fullOpenCloseTime / 100;

    return durationPerPercentage;
  }

  async startUpdatingCurrentPositionAtIntervals () {
    catchDelayCancelError(async () => {
      const { config, serviceManager, state } = this;
      const { totalDurationOpen, totalDurationClose } = config;
      
      const durationPerPercentage = this.determineOpenCloseDurationPerPercent({ opening: state.opening, totalDurationOpen, totalDurationClose })

      // Wait for a single % to increase/decrease
      this.updateCurrentPositionPromise = delayForDuration(durationPerPercentage)
      await this.updateCurrentPositionPromise

      // Set the new currentPosition
      let currentValue = state.currentPosition || 0;

      if (state.opening) {currentValue++;}
      if (!state.opening) {currentValue--;}

      serviceManager.setCharacteristic(Characteristic.CurrentPosition, currentValue);

      // Let's go again
      this.startUpdatingCurrentPositionAtIntervals();
    });
  }

  setupServiceManager () {
    const { data, log, name, serviceManagerType } = this;

    this.serviceManager = new ServiceManagerTypes[serviceManagerType](name, Service.Door, log);

    this.serviceManager.addToggleCharacteristic({
      name: 'currentPosition',
      type: Characteristic.CurrentPosition,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {

      }
    });

    this.serviceManager.addToggleCharacteristic({
      name: 'positionState',
      type: Characteristic.PositionState,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {

      }
    });

    this.serviceManager.addToggleCharacteristic({
      name: 'targetPosition',
      type: Characteristic.TargetPosition,
      bind: this,
      getMethod: this.getCharacteristicValue,
      setMethod: this.setCharacteristicValue,
      props: {
        setValuePromise: this.setTargetPosition.bind(this)
      }
    });
  }
}

module.exports = DoorAccessory;
