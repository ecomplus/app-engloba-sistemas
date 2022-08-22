const axios = require('axios')
const ecomUtils = require('@ecomplus/utils')

exports.post = ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }

  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  // get token
  const { token } = appData
  if (!token) {
    // must have configured a3 tecnologia token token
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Token or document unset on app hidden data (merchant must configure the app)'
    })
  }

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const originZip = params.from
    ? params.from.zip.replace(/\D/g, '')
    : appData.zip ? appData.zip.replace(/\D/g, '') : ''

  
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  /* DO THE STUFF HERE TO FILL RESPONSE OBJECT WITH SHIPPING SERVICES */

  if (!originZip) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }


  if (params.items) {
    let finalWeight = 0
    params.items.forEach(({ quantity, dimensions, weight }) => {
      let physicalWeight = 0
      let cubicWeight = 1

      // sum physical weight
      if (weight && weight.value) {
        switch (weight.unit) {
          case 'kg':
            physicalWeight = weight.value
            break
          case 'g':
            physicalWeight = weight.value / 1000
            break
          case 'mg':
            physicalWeight = weight.value / 1000000
        }
      }

      // sum total items dimensions to calculate cubic weight
      if (dimensions) {
        const sumDimensions = {}
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            let dimensionValue
            switch (dimension.unit) {
              case 'cm':
                dimensionValue = dimension.value / 100
                break
              case 'm':
                dimensionValue = dimension.value
                break
              case 'mm':
                dimensionValue = dimension.value / 1000
            }
            // add/sum current side to final dimensions object
            if (dimensionValue) {
              sumDimensions[side] = sumDimensions[side]
                ? sumDimensions[side] + dimensionValue
                : dimensionValue
            }
          }
        }

        // calculate cubic weight
        // https://suporte.boxloja.pro/article/82-correios-calculo-frete
        // (C x L x A) / 6.000
        for (const side in sumDimensions) {
          if (sumDimensions[side]) {
            cubicWeight *= sumDimensions[side]
          }
        }
        if (cubicWeight > 0) {
          cubicWeight *= 167
        }
      }
      finalWeight += (quantity * (cubicWeight > 50 ? cubicWeight : physicalWeight))
    })
    const weightParse = String(finalWeight).replace('.', ',')
    const totalParse = String(params.subtotal).replace('.', ',')
    return axios.post(
      `https://englobasistemas.com.br/financeiro/api/fretes/calcularFrete?apikey=${token}&local=BR&valor=${totalParse}&cep=${destinationZip}&peso=${weightParse}`,
      {
        timeout: (params.is_checkout_confirmation ? 8000 : 5000)
      }
    )
    .then(result => {
      const { data, status } = result

      if (data && status === 200) {
        // success response
        // parse to E-Com Plus shipping line object
        const price = parseFloat(
          data.frete.replace(',', '.')
        )
        // push shipping service object to response
        response.shipping_services.push({
          label: 'Transportadora A3 Logistica',
          carrier: data.transportadora,
          service_name: data.transportadora,
          service_code: data.sigla_base_destino,
          shipping_line: {
            from: {
              ...params.from,
              zip: originZip
            },
            to: params.to,
            price,
            total_price: price,
            discount: 0,
            delivery_time: {
              days: parseInt(data.prazo, 10),
              working_days: true
            },
            posting_deadline: {
              days: 3,
              ...appData.posting_deadline
            },
            flags: ['a3-log-ws', `a3-log-${data.sigla_base_destino}`.substr(0, 20)]
          }
        })
        res.send(response)
      } else {
        // console.log(data)
        const err = new Error('Invalid a3-log calculate response')
        err.response = { data, status }
        throw err
      }
    })

    .catch(err => {
      let { message, response } = err
      if (response && response.data) {
        // try to handle A3 Tecnologia error response
        const { data } = response
        let result
        if (typeof data === 'string') {
          try {
            result = JSON.parse(data)
          } catch (e) {
          }
        } else {
          result = data
        }
        console.log('> A3 Tecnologia invalid result:', data)
        if (result && result.data) {
          // A3 Tecnologia error message
          return res.status(409).send({
            error: 'CALCULATE_FAILED',
            message: result.data
          })
        }
        message = `${message} (${response.status})`
      } else {
        console.error(err)
      }
      return res.status(409).send({
        error: 'CALCULATE_ERR',
        message
      })
    })
} else {
  res.status(400).send({
    error: 'CALCULATE_EMPTY_CART',
    message: 'Cannot calculate shipping without cart items'
  })
}

res.send(response)
}
