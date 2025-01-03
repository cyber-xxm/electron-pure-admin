import Axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type CustomParamsSerializer
} from "axios";
import type {
  RequestMethods,
  PureHttpResponse,
  PureHttpRequestConfig
} from "./types.d";
import {stringify} from "qs";
import {getToken, formatToken} from "@/utils/auth";
import {useUserStoreHook} from "@/store/modules/user";

const net = require("net")

// 相关配置请参考：www.axios-js.com/zh-cn/docs/#axios-request-config-1
const defaultConfig: AxiosRequestConfig = {
  // 请求超时时间
  timeout: 10000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest"
  },
  // 数组格式参数序列化（https://github.com/axios/axios/issues/5142）
  paramsSerializer: {
    serialize: stringify as unknown as CustomParamsSerializer
  }
};

class PureHttp {
  constructor() {
    this.httpInterceptorsRequest();
    this.httpInterceptorsResponse();
  }

  /** `token`过期后，暂存待执行的请求 */
  private static requests = [];

  /** 防止重复刷新`token` */
  private static isRefreshing = false;

  /** 初始化配置对象 */
  private static initConfig: PureHttpRequestConfig = {};

  /** 保存当前`Axios`实例对象 */
  private static axiosInstance: AxiosInstance = Axios.create(defaultConfig);

  /** 重连原始请求 */
  private static retryOriginalRequest(config: PureHttpRequestConfig) {
    return new Promise(resolve => {
      PureHttp.requests.push((token: string) => {
        config.headers["Authorization"] = formatToken(token);
        resolve(config);
      });
    });
  }

  /** 请求拦截 */
  private httpInterceptorsRequest(): void {
    PureHttp.axiosInstance.interceptors.request.use(
      async (config: PureHttpRequestConfig): Promise<any> => {
        await Promise.reject({config: config})
      },
      error => {
        return Promise.reject(error);
      }
    );
  }

  /** 响应拦截 */
  private httpInterceptorsResponse(): void {
    const instance = PureHttp.axiosInstance;
    instance.interceptors.response.use((response: PureHttpResponse) => {
        const $config = response.config;
        // 优先判断post/get等方法是否传入回调，否则执行初始化设置等回调
        if (typeof $config.beforeResponseCallback === "function") {
          $config.beforeResponseCallback(response);
          return response.data;
        }
        if (PureHttp.initConfig.beforeResponseCallback) {
          PureHttp.initConfig.beforeResponseCallback(response);
          return response.data;
        }
        return response.data;
      },
      (error) => {
        // 前面请求拦截拒绝，一定会进来这边
        const $config = error.config;

        // 优先判断post/get等方法是否传入回调，否则执行初始化设置等回调
        if (typeof $config.beforeRequestCallback === "function") {
          $config.beforeRequestCallback($config);
          return new Promise((resolve, reject) => {
            this.sendRequest($config, (err, data) => {
              if (err) {
                console.error("An error occurred:", err);
                reject(err)
              } else {
                resolve(this.getResponseData(data))
              }
            })
          });
        }
        if (PureHttp.initConfig.beforeRequestCallback) {
          PureHttp.initConfig.beforeRequestCallback($config);
          return new Promise((resolve, reject) => {
            this.sendRequest($config, (err, data) => {
              if (err) {
                console.error("An error occurred:", err);
                reject(err)
              } else {
                resolve(this.getResponseData(data))
              }
            })
          });
        }
        /** 请求白名单，放置一些不需要`token`的接口（通过设置请求白名单，防止`token`过期后再请求造成的死循环问题） */
        const whiteList = ["/refresh-token", "/login"];
        return whiteList.some(url => $config.url.endsWith(url))
          ? new Promise((resolve, reject) => {
            this.sendRequest($config, (err, data) => {
              if (err) {
                console.error("An error occurred:", err);
                reject(err)
              } else {
                resolve(this.getResponseData(data))
              }
            })
          })
          : new Promise((resolve, reject) => {
            const data = getToken();
            if (data) {
              const now = new Date().getTime();
              const expired = parseInt(data.expires) - now <= 0;
              if (expired) {
                if (!PureHttp.isRefreshing) {
                  PureHttp.isRefreshing = true;
                  // token过期刷新
                  useUserStoreHook()
                    .handRefreshToken({refreshToken: data.refreshToken})
                    .then(res => {
                      const token = res.data.accessToken;
                      $config.headers["Authorization"] = formatToken(token);
                      PureHttp.requests.forEach(cb => cb(token));
                      PureHttp.requests = [];
                    })
                    .finally(() => {
                      PureHttp.isRefreshing = false;
                    });
                }
                resolve(PureHttp.retryOriginalRequest($config));
              } else {
                $config.headers["Authorization"] = formatToken(
                  data.accessToken
                );
                this.sendRequest($config, (err, data) => {
                  if (err) {
                    reject(err)
                  } else {
                    resolve(this.getResponseData(data))
                  }
                })
              }
            } else {
              this.sendRequest($config, (err, data) => {
                if (err) {
                  reject(err)
                } else {
                  resolve(this.getResponseData(data))
                }
              })
            }
          });
      }
    );
  }

  private getResponseData(data) {
    let resp = new Buffer(data, 'base64').toString("utf-8");
    console.log('response data: ', resp)
    let failedData = {"success": false, "message": "获取数据失败"}
    let r = resp ? JSON.parse(resp) : failedData
    return r && r.data ? JSON.parse(JSON.parse(r.data)) : failedData
  }

  private sendRequest(config, callback) {
    // 提取请求信息
    const method = config.method.toUpperCase();  // 请求方法（GET、POST 等）
    const url = config.url;                      // 请求的 URL
    const headers = config.headers;              // 请求头
    const body = config.data ? JSON.stringify(config.data) : ''; // 请求体（如果有）

    // 构造 HTTP 请求报文
    const httpRequest = `${method} ${url} HTTP/1.1\r\n` +
      `Host: ${headers['Host'] || 'example.com'}\r\n` +
      `User-Agent: axios\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n` +
      `\r\n` +
      body;

    // 打印 TCP 请求报文（你可以在这里做日志记录等处理）
    console.log('TCP Request:', httpRequest);
    this.sendTcp(httpRequest, callback)
  }

  // TCP 客户端函数，模拟发送 HTTP 请求的 TCP 报文
  private sendTcp(httpRequest, callback) {
    const client = new net.Socket();

    client.connect(8081, "127.0.0.1", () => {
      console.log("Connected to server");
      client.write(new Buffer(httpRequest).toString('base64'));
    });

    client.on("data", data => {
      // 调用回调函数并传递数据
      callback(null, data.toString());
      client.destroy(); // 数据接收完成后关闭连接
    });

    client.on("close", () => {
      console.log("Connection closed");
    });

    client.on("error", err => {
      console.error("TCP Error:", err);
      // 如果发生错误，也调用回调函数并传递错误
      callback(err, null);
    });
  }

  /** 通用请求工具函数 */
  public request<T>(
    method: RequestMethods,
    url: string,
    param?: AxiosRequestConfig,
    axiosConfig?: PureHttpRequestConfig
  ): Promise<T> {
    const config = {
      method,
      url,
      ...param,
      ...axiosConfig
    } as PureHttpRequestConfig;

    // 单独处理自定义请求/响应回调
    return new Promise((resolve, reject) => {
      PureHttp.axiosInstance
        .request(config)
        .then((response: undefined) => {
          resolve(response);
        })
        .catch(error => {
          reject(error);
        });
    });
  }

  /** 单独抽离的`post`工具函数 */
  public post<T, P>(
    url: string,
    params?: AxiosRequestConfig<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("post", url, params, config);
  }

  /** 单独抽离的`get`工具函数 */
  public get<T, P>(
    url: string,
    params?: AxiosRequestConfig<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("get", url, params, config);
  }

  /** 单独抽离的`put`工具函数 */
  public put<T, P>(
    url: string,
    params?: AxiosRequestConfig<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("put", url, params, config);
  }

  /** 单独抽离的`patch`工具函数 */
  public patch<T, P>(
    url: string,
    params?: AxiosRequestConfig<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("patch", url, params, config);
  }

  /** 单独抽离的`delete`工具函数 */
  public delete<T, P>(
    url: string,
    params?: AxiosRequestConfig<P>,
    config?: PureHttpRequestConfig
  ): Promise<T> {
    return this.request<T>("delete", url, params, config);
  }
}

export const http = new PureHttp();
