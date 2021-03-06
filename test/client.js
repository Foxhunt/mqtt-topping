/* eslint "no-console": "off" */

import chai, { expect } from "chai"
import chaiAsPromised from "chai-as-promised"
import sinon from "sinon"
import sinonChai from "sinon-chai"

import { waitFor } from "./testHelpers"
import topping from "../src/topping"

chai.use(chaiAsPromised)
chai.use(sinonChai)

const httpBrokerUri = process.env.HTTP_BROKER_URI || "http://localhost:8080"
const tcpBrokerUri = process.env.TCP_BROKER_URI || "tcp://localhost"

describe("MQTT Client", function() {
  this.timeout(5000)

  beforeEach(function() {
    sinon.spy(console, "log")

    this.client = topping.connect(tcpBrokerUri, httpBrokerUri)
    this.testTopic = `test/topping-${Date.now()}`

    return waitFor(() => this.client.isConnected).then(() =>
      this.client.publish(`${this.testTopic}/foo`, "bar")
    ).then(() =>
      this.client.publish(`${this.testTopic}/baz`, 23)
    )
  })

  afterEach(function() {
    console.log.restore()
    return this.client.unpublishRecursively(this.testTopic).then(() => this.client.disconnect())
  })

  describe("subscribe", function() {
    it("should retrieve retained messages", function() {
      const fooHandler = sinon.spy()
      const bazHandler = sinon.spy()

      this.client.subscribe(`${this.testTopic}/foo`, fooHandler)
      this.client.subscribe(`${this.testTopic}/baz`, bazHandler)

      return waitFor(() => fooHandler.called && bazHandler.called).then(() => {
        expect(fooHandler).to.have.been.calledOnce.and.calledWith("bar", `${this.testTopic}/foo`)
        expect(bazHandler).to.have.been.calledOnce.and.calledWith(23, `${this.testTopic}/baz`)
      })
    })

    it("should retrieve non-retained messages", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, handler).then(() =>
        this.client.publish(eventTopic, "hello")
      ).then(() =>
        waitFor(() => handler.called)
      ).then(() => {
        expect(handler).to.have.been.calledWith("hello", eventTopic)
      })
    })

    it("should receive messages with empty payload", function() {
      const handler = sinon.spy()

      return this.client.subscribe(`${this.testTopic}/foo`, handler).then(() =>
        this.client.unpublish(`${this.testTopic}/foo`)
      ).then(() =>
        waitFor(() => handler.calledTwice)
      ).then(() => {
        expect(handler).to.have.been.calledWith("bar", `${this.testTopic}/foo`)
        expect(handler).to.have.been.calledWith(undefined, `${this.testTopic}/foo`)
      })
    })

    context("with wildcard", function() {
      it("should retrieve retained messages using hash wildcard", function() {
        const handler = sinon.spy()
        this.client.subscribe(`${this.testTopic}/#`, handler)

        return waitFor(() => handler.calledTwice).then(() => {
          expect(handler).to.have.been
            .calledWith("bar", `${this.testTopic}/foo`)
            .calledWith(23, `${this.testTopic}/baz`)
        })
      })

      it("should retrieve retained messages using plus wildcard", function() {
        const handler = sinon.spy()
        this.client.subscribe(`${this.testTopic}/+`, handler)

        return waitFor(() => handler.calledTwice).then(() => {
          expect(handler).to.have.been
            .calledWith("bar", `${this.testTopic}/foo`)
            .calledWith(23, `${this.testTopic}/baz`)
        })
      })
    })

    it("should ignore malformed JSON payloads", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, handler).then(() => {
        this.client.client.publish(eventTopic, "this is invalid JSON")
        this.client.client.publish(eventTopic, "42")
        return waitFor(() => handler.called)
      }).then(() => {
        expect(handler).to.have.been.calledOnce.and.calledWith(42, eventTopic)
        expect(console.log).to.have.been.calledWith(
          sinon.match(eventTopic).and(sinon.match("this is invalid JSON"))
        )
      })
    })

    it("should receive raw payload when JSON parsing is disabled", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, { parseJson: false }, handler).then(() => {
        this.client.client.publish(eventTopic, "this is invalid JSON")
        this.client.client.publish(eventTopic, "42")
        return waitFor(() => handler.calledTwice)
      }).then(() => {
        expect(handler).to.have.been
          .calledWith("this is invalid JSON", eventTopic)
          .calledWith("42", eventTopic)
      })
    })

    it("should not receive messages after unsubscribing", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, handler).then(() =>
        this.client.publish(eventTopic, "hello")
      ).then(() =>
        waitFor(() => handler.called)
      ).then(() =>
        this.client.unsubscribe(eventTopic, handler)
      ).then(() =>
        this.client.publish(eventTopic, "goodbye")
      ).then(() =>
        this.client.subscribe(eventTopic, handler)
      ).then(() =>
        this.client.publish(eventTopic, "hello again")
      ).then(() =>
        waitFor(() => handler.calledTwice)
      ).then(() => {
        expect(handler).not.to.have.been.calledWith("goodbye")
        expect(handler).to.have.been.calledWith("hello again")
      })
    })

    it("should allow unsubscribing from a handler callback", function(done) {
      const handler = function() {}
      const outerTopic = `${this.testTopic}/onFoo`
      const innerTopic = `${this.testTopic}/onBar`

      this.client.subscribe(outerTopic, () => {
        this.client.unsubscribe(innerTopic, handler).then(done)
      }).then(() =>
        this.client.subscribe(innerTopic, handler)
      ).then(() =>
        this.client.publish(outerTopic, null)
      )
    })
  })

  describe("publish", function() {
    it("should use QoS 2 by default", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, handler).then(() =>
        this.client.publish(eventTopic, "hello")
      ).then(() =>
        waitFor(() => handler.called)
      ).then(() => {
        expect(handler).to.have.been.calledWith("hello", eventTopic, sinon.match({ qos: 2 }))
      })
    })

    it("should override QoS", function() {
      const handler = sinon.spy()
      const eventTopic = `${this.testTopic}/onEvent`

      return this.client.subscribe(eventTopic, handler).then(() =>
        this.client.publish(eventTopic, "hello", { qos: 0 })
      ).then(() =>
        waitFor(() => handler.called)
      ).then(() => {
        expect(handler).to.have.been.calledWith("hello", eventTopic, sinon.match({ qos: 0 }))
      })
    })

    it("should publish messages without stringifying", function() {
      const topic = `${this.testTopic}/raw`

      return this.client.publish(topic, "invalid\nJSON", { stringifyJson: false }).then(() => {
        const query = this.client.query({ topic, parseJson: false })
        return expect(query).to.eventually.deep.equal({ topic, payload: "invalid\nJSON" })
      })
    })

    it("should unpublish messages", function() {
      const query = this.client.unpublish(`${this.testTopic}/foo`).then(() =>
        this.client.query({ topic: this.testTopic, depth: 1 })
      ).then(result =>
        result.children
      )

      return expect(query).to.eventually.deep.equal([
        { topic: `${this.testTopic}/baz`, payload: 23 }
      ])
    })

    it("should unpublish messages recursively", function() {
      const query = this.client.unpublishRecursively(this.testTopic).then(() =>
        this.client.query({ topic: this.testTopic })
      )

      return Promise.all([
        expect(query).to.be.rejected,
        query.catch(error => expect(error).to.deep.equal({ topic: this.testTopic, error: 404 }))
      ])
    })
  })
})
